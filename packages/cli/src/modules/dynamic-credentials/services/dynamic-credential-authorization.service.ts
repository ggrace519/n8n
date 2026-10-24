import type { WorkflowExecutionStatus } from '@n8n/api-types';
import { LockNamespace, LockService, Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import {
	CredentialsRepository,
	WorkflowRepository,
	type CredentialsEntity,
	type User,
	type WorkflowEntity,
} from '@n8n/db';
import { Service } from '@n8n/di';
import type { Request, Response } from 'express';
import { createHash, randomBytes } from 'node:crypto';

import { CredentialsFinderService } from '@/credentials/credentials-finder.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { OAuthBrowserBindingService } from '@/oauth/oauth-browser-binding.service';
import type { CreateCsrfStateData } from '@/oauth/oauth.service';
import { OauthService } from '@/oauth/oauth.service';
import { CacheService } from '@/services/cache/cache.service';
import { UrlService } from '@/services/url.service';
import { WorkflowFinderService } from '@/workflows/workflow-finder.service';

import { SYSTEM_RESOLVER_ID } from '../constants';
import { EXTERNAL_IDENTITY_SOURCE } from '../credential-resolvers/identifiers/oauth2-userinfo-identifier';
import { DynamicCredentialEntryStorage } from '../credential-resolvers/storage/dynamic-credential-entry-storage';
import { DynamicCredentialUserEntryStorage } from '../credential-resolvers/storage/dynamic-credential-user-entry-storage';
import { collectCredentialIds } from './collect-credential-ids';
import { CredentialResolverService } from './credential-resolver.service';
import { CredentialResolverWorkflowService } from './credential-resolver-workflow.service';

/**
 * Who a dynamic-credential request acts for: the signed-in n8n user (system
 * resolver), or an external user named by a Bearer token that a non-system
 * resolver verifies. `sessionUser` is the signed-in user, if any, behind an
 * external request — their credential access still applies.
 */
export type CallerIdentity =
	| { kind: 'user'; user: User; cookieToken: string }
	| { kind: 'external'; authorizationHeader: string; sessionUser?: User };

/** The browser request a flow is started from, so the flow can be bound to it. */
export type BrowserContext = { req: Request; res: Response };

type CredentialStatus = NonNullable<WorkflowExecutionStatus['credentials']>[number];

/**
 * What a single-use link starts: the identity's authorization header and its
 * source travel server-side, so the flow resolves the same subject the gate saw.
 */
export type AuthorizeLink = {
	credentialId: string;
	resolverId: string;
	authorizationHeader: string;
	/** Credential-context source, e.g. `n8n-oauth` for an MCP client's n8n token. */
	source: string;
	/** Protected resource an `n8n-oauth` token was issued for; its audience is checked on store. */
	resource?: string;
	/** Set when the identity is an n8n user (system resolver). */
	userId?: string;
};

const LINK_TTL_MS = 10 * 60_000;
const LINK_CACHE_PREFIX = 'dynamic-credentials:authorize-link:';

/**
 * The externally facing half of dynamic credentials: report which end-user
 * credentials a workflow still needs, start the OAuth authorization that
 * connects one, and revoke a connection. Storage and subject resolution stay in
 * `CredentialResolverService`; the OAuth callback that stores the tokens is the
 * existing `origin: 'dynamic-credential'` path in `OauthService`.
 */
@Service()
export class DynamicCredentialAuthorizationService {
	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly urlService: UrlService,
		private readonly cacheService: CacheService,
		private readonly lockService: LockService,
		private readonly oauthService: OauthService,
		private readonly browserBindingService: OAuthBrowserBindingService,
		private readonly credentialsFinderService: CredentialsFinderService,
		private readonly workflowFinderService: WorkflowFinderService,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly workflowRepository: WorkflowRepository,
		private readonly resolverWorkflowService: CredentialResolverWorkflowService,
		private readonly resolverService: CredentialResolverService,
		private readonly userEntryStorage: DynamicCredentialUserEntryStorage,
		private readonly entryStorage: DynamicCredentialEntryStorage,
	) {}

	async getExecutionStatus(
		workflowId: string,
		identity: CallerIdentity,
	): Promise<WorkflowExecutionStatus> {
		const workflow = await this.findStatusWorkflow(workflowId, identity);

		const credentialIds = collectCredentialIds(workflow.nodes ?? []);
		const resolvable =
			credentialIds.length === 0
				? []
				: (await this.credentialsRepository.getManyByIds(credentialIds)).filter(
						(credential) => credential.isResolvable,
					);

		const resolverFor = (credential: CredentialsEntity) =>
			credential.resolverId ?? workflow.settings?.credentialResolverId ?? SYSTEM_RESOLVER_ID;

		// An external caller may only inspect workflows set up for external users;
		// anything else answers as if it did not exist, so ids can't be enumerated.
		if (
			identity.kind === 'external' &&
			!resolvable.some((credential) => resolverFor(credential) !== SYSTEM_RESOLVER_ID)
		) {
			throw new NotFoundError(`Workflow "${workflowId}" could not be found.`);
		}

		const credentials: CredentialStatus[] = [];
		for (const credential of resolvable) {
			credentials.push(await this.statusFor(credential, resolverFor(credential), identity));
		}

		return {
			workflowId,
			readyToExecute: credentials.every((c) => c.credentialStatus === 'configured'),
			credentials,
		};
	}

	/**
	 * Returns the OAuth provider URL that connects `credentialId` for `identity`.
	 * When started from a browser the flow is bound to it, so only that browser
	 * can complete the consent.
	 */
	async startAuthorization(
		credentialId: string,
		resolverId: string,
		identity: CallerIdentity,
		browser?: BrowserContext,
	): Promise<string> {
		const credential = await this.findAuthorizableCredential(credentialId, identity);
		await this.assertResolverServesCredential(credential, resolverId);

		let csrfData: CreateCsrfStateData;
		if (identity.kind === 'user') {
			if (resolverId !== SYSTEM_RESOLVER_ID) {
				throw new BadRequestError('Signed-in users connect through the n8n resolver');
			}
			csrfData = {
				cid: credential.id,
				origin: 'dynamic-credential',
				userId: identity.user.id,
				credentialResolverId: resolverId,
				authorizationHeader: `Bearer ${identity.cookieToken}`,
				authMetadata: { source: 'manual-execution' },
			};
		} else {
			if (resolverId === SYSTEM_RESOLVER_ID) {
				throw new BadRequestError('External users connect through a non-n8n resolver');
			}
			// Verify the caller before a flow is started on their behalf; the callback
			// verifies again when it stores the tokens.
			await this.resolverService.resolveExternalSubject(
				resolverId,
				identity.authorizationHeader,
				credential.id,
			);
			// No userId: the callback then skips its same-user check, as it does for
			// every externally initiated flow.
			csrfData = {
				cid: credential.id,
				origin: 'dynamic-credential',
				credentialResolverId: resolverId,
				authorizationHeader: identity.authorizationHeader,
				authMetadata: { source: EXTERNAL_IDENTITY_SOURCE },
			};
		}

		this.bindToBrowser(csrfData, browser);
		return await this.oauthService.generateAOauth2AuthUri(credential, csrfData);
	}

	/**
	 * Mints a single-use link that starts the authorization for an identity
	 * without ever putting its token in a URL.
	 */
	async issueAuthorizeLink(link: AuthorizeLink): Promise<string> {
		const token = randomBytes(32).toString('base64url');
		await this.cacheService.set(`${LINK_CACHE_PREFIX}${token}`, link, LINK_TTL_MS);
		return `${this.restBaseUrl()}/credentials/${encodeURIComponent(link.credentialId)}/authorize?token=${token}`;
	}

	/**
	 * Consumes a link minted by `issueAuthorizeLink` and returns the provider URL,
	 * binding the flow to the browser that opened the link.
	 */
	async consumeAuthorizeLink(
		credentialId: string,
		token: string,
		browser: BrowserContext,
		openerUser?: User,
	): Promise<string> {
		const key = `${LINK_CACHE_PREFIX}${token}`;
		// Claim under a lease (Redis under multi-main) so two concurrent requests
		// can't both read the link before it is deleted. The lease key is hashed so
		// the link token never sits in the lock keyspace.
		const leaseKey = createHash('sha256').update(key).digest('hex');
		const link = await this.lockService.withLease(LockNamespace.KNOWN_LOCKS, leaseKey, async () => {
			const found = await this.cacheService.get<AuthorizeLink>(key);
			await this.cacheService.delete(key);
			return found;
		});
		if (!link || link.credentialId !== credentialId) {
			throw new NotFoundError('This authorization link is invalid or has expired.');
		}
		// A link minted for an n8n user connects that user's account, so only that
		// user may open it — a forwarded link can't land someone else's provider
		// tokens under them.
		if (link.userId && openerUser?.id !== link.userId) {
			throw new NotFoundError('This authorization link is invalid or has expired.');
		}
		// Only an external caller's own token is ever sent to a non-n8n resolver.
		if (link.resolverId !== SYSTEM_RESOLVER_ID && link.source !== EXTERNAL_IDENTITY_SOURCE) {
			throw new NotFoundError('This authorization link is invalid or has expired.');
		}

		const credential = await this.credentialsRepository.findOneBy({ id: link.credentialId });
		if (!credential?.isResolvable) {
			throw new NotFoundError(`Credential "${credentialId}" could not be found.`);
		}
		if (link.resolverId !== SYSTEM_RESOLVER_ID) {
			await this.resolverService.resolveExternalSubject(
				link.resolverId,
				link.authorizationHeader,
				credential.id,
			);
		}

		const csrfData: CreateCsrfStateData = {
			cid: credential.id,
			origin: 'dynamic-credential',
			credentialResolverId: link.resolverId,
			authorizationHeader: link.authorizationHeader,
			authMetadata: { source: link.source, ...(link.resource ? { resource: link.resource } : {}) },
			...(link.userId ? { userId: link.userId } : {}),
		};
		this.bindToBrowser(csrfData, browser);
		return await this.oauthService.generateAOauth2AuthUri(credential, csrfData);
	}

	/** Removes the caller's own connection for the credential under that resolver. */
	async revoke(credentialId: string, resolverId: string, identity: CallerIdentity): Promise<void> {
		const credential = await this.findAuthorizableCredential(credentialId, identity);

		if (identity.kind === 'user') {
			await this.userEntryStorage.deleteCredentialData(
				credential.id,
				identity.user.id,
				resolverId,
				{},
			);
			return;
		}

		const subject = await this.resolverService.resolveExternalSubject(
			resolverId,
			identity.authorizationHeader,
			credential.id,
		);
		await this.entryStorage.deleteCredentialData(credential.id, subject, resolverId, {});
	}

	private async statusFor(
		credential: CredentialsEntity,
		resolverId: string,
		identity: CallerIdentity,
	): Promise<CredentialStatus> {
		const base = {
			credentialId: credential.id,
			credentialName: credential.name,
			credentialType: credential.type,
		};

		const isSystem = resolverId === SYSTEM_RESOLVER_ID;
		// Each identity kind connects through exactly one kind of resolver.
		if (isSystem !== (identity.kind === 'user')) {
			return { ...base, credentialStatus: 'resolver_missing' };
		}

		const stored =
			identity.kind === 'user'
				? await this.userEntryStorage.getCredentialData(
						credential.id,
						identity.user.id,
						resolverId,
						{},
					)
				: await this.entryStorage.getCredentialData(
						credential.id,
						await this.resolverService.resolveExternalSubject(
							resolverId,
							identity.authorizationHeader,
							credential.id,
						),
						resolverId,
						{},
					);

		const query = `resolverId=${encodeURIComponent(resolverId)}${identity.kind === 'user' ? '&authSource=cookie' : ''}`;
		const credentialUrl = `${this.restBaseUrl()}/credentials/${encodeURIComponent(credential.id)}`;

		// Both links are always offered: authorizing again reconnects, revoking a missing entry is a no-op.
		return {
			...base,
			credentialStatus: stored === null ? 'missing' : 'configured',
			authorizationUrl: `${credentialUrl}/authorize?${query}`,
			revokeUrl: `${credentialUrl}/revoke?${query}`,
		};
	}

	/** Signed-in callers need read access to the workflow; external callers can't name one they lack. */
	private async findStatusWorkflow(
		workflowId: string,
		identity: CallerIdentity,
	): Promise<WorkflowEntity> {
		const sessionUser = identity.kind === 'user' ? identity.user : identity.sessionUser;
		const workflow = sessionUser
			? await this.workflowFinderService.findWorkflowForUser(workflowId, sessionUser, [
					'workflow:read',
				])
			: await this.workflowRepository.findById(workflowId);
		if (!workflow) throw new NotFoundError(`Workflow "${workflowId}" could not be found.`);
		return workflow;
	}

	/**
	 * Any request carrying an n8n session needs `credential:connect` on the
	 * credential; a token-only external request may reach any end-user credential,
	 * since what it stores is keyed by its own verified subject.
	 */
	private async findAuthorizableCredential(
		credentialId: string,
		identity: CallerIdentity,
	): Promise<CredentialsEntity> {
		const sessionUser = identity.kind === 'user' ? identity.user : identity.sessionUser;
		const credential = sessionUser
			? await this.credentialsFinderService.findCredentialForUser(credentialId, sessionUser, [
					'credential:connect',
				])
			: await this.credentialsRepository.findOneBy({ id: credentialId });

		if (!credential?.isResolvable) {
			this.logger.debug('Dynamic credential authorization refused', { credentialId });
			throw new NotFoundError(`Credential "${credentialId}" could not be found.`);
		}
		return credential;
	}

	/**
	 * A non-n8n resolver may only connect a credential it actually serves: the
	 * credential's own resolver, or one a workflow using the credential selects.
	 */
	private async assertResolverServesCredential(
		credential: CredentialsEntity,
		resolverId: string,
	): Promise<void> {
		if (resolverId === SYSTEM_RESOLVER_ID || credential.resolverId === resolverId) return;

		const selecting = await this.resolverWorkflowService.findAffectedWorkflows(resolverId);
		if (selecting.length > 0) {
			const workflows = await this.workflowRepository.findByIds(selecting.map((w) => w.id));
			const serves = workflows.some((workflow) =>
				collectCredentialIds(workflow.nodes ?? []).includes(credential.id),
			);
			if (serves) return;
		}
		throw new BadRequestError('This resolver does not serve this credential');
	}

	/**
	 * Binds an OAuth flow to the browser starting it, whatever
	 * `N8N_OAUTH_BROWSER_BINDING` says: dynamic-credential flows land tokens under
	 * an identity, so a consent completed in another browser must not count.
	 */
	private bindToBrowser(csrfData: CreateCsrfStateData, browser?: BrowserContext): void {
		if (!browser) return;
		const nonce = this.browserBindingService.ensureBindingCookie(browser.req, browser.res);
		csrfData.bindingHash = this.browserBindingService.computeHash(nonce);
	}

	/** Absolute REST base from configuration, never from the request's Host header. */
	private restBaseUrl(): string {
		return `${this.urlService.getInstanceBaseUrl()}/${this.globalConfig.endpoints.rest}`;
	}
}
