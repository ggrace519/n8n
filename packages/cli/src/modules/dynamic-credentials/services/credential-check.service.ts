import { Logger } from '@n8n/backend-common';
import { CredentialsRepository, WorkflowRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { Cipher } from 'n8n-core';
import type {
	CredentialCheckResult,
	ICredentialContext,
	CredentialCheckStatus,
	DynamicCredentialCheckProxyProvider,
} from 'n8n-workflow';
import { toCredentialContext } from 'n8n-workflow';

import { OAuthTokenVerifierProxy } from '@/services/oauth-token-verifier-proxy.service';

import { SYSTEM_RESOLVER_ID } from '../constants';
import { N8NIdentifier } from '../credential-resolvers/identifiers/n8n-identifier';
import { DynamicCredentialUserEntryStorage } from '../credential-resolvers/storage/dynamic-credential-user-entry-storage';
import { collectCredentialIds } from './collect-credential-ids';
import { DynamicCredentialAuthorizationService } from './dynamic-credential-authorization.service';

/**
 * Pre-execution gate exposed through the module's workflow context: tells a
 * webhook/MCP trigger whether every end-user credential the workflow needs is
 * already connected for the identity that triggered it, before anything runs.
 */
@Service()
export class CredentialCheckService implements DynamicCredentialCheckProxyProvider {
	constructor(
		private readonly logger: Logger,
		private readonly cipher: Cipher,
		private readonly n8nIdentifier: N8NIdentifier,
		private readonly workflowRepository: WorkflowRepository,
		private readonly credentialsRepository: CredentialsRepository,
		private readonly userEntryStorage: DynamicCredentialUserEntryStorage,
		private readonly authorizationService: DynamicCredentialAuthorizationService,
		private readonly oauthTokenVerifier: OAuthTokenVerifierProxy,
	) {}

	async checkCredentialStatus(
		workflowId: string,
		executionContext: { credentials?: string },
	): Promise<CredentialCheckResult> {
		const workflow = await this.workflowRepository.findById(workflowId);
		if (!workflow) return { readyToExecute: true, credentials: [] };

		const credentialIds = collectCredentialIds(workflow.nodes ?? []);
		if (credentialIds.length === 0) return { readyToExecute: true, credentials: [] };

		const resolvable = (await this.credentialsRepository.getManyByIds(credentialIds)).filter(
			(credential) => credential.isResolvable,
		);
		if (resolvable.length === 0) return { readyToExecute: true, credentials: [] };

		const caller = await this.resolveCaller(executionContext, workflowId);

		const credentials: CredentialCheckStatus[] = [];
		for (const credential of resolvable) {
			const resolverId =
				credential.resolverId ?? workflow.settings?.credentialResolverId ?? SYSTEM_RESOLVER_ID;
			const status = await this.statusFor(credential.id, resolverId, caller?.userId ?? null);

			credentials.push({
				credentialId: credential.id,
				credentialName: credential.name,
				credentialType: credential.type,
				resolverId,
				status,
				// A single-use link the caller can follow to connect it — the gate's
				// identity travels server-side, never in the URL.
				...(status === 'missing' && caller
					? {
							authorizationUrl: await this.authorizationService.issueAuthorizeLink({
								credentialId: credential.id,
								resolverId,
								authorizationHeader: caller.authorizationHeader,
								source: caller.source,
								resource: caller.resource,
								userId: caller.userId,
							}),
						}
					: {}),
			});
		}

		return {
			readyToExecute: credentials.every((c) => c.status === 'configured'),
			credentials,
		};
	}

	private async statusFor(
		credentialId: string,
		resolverId: string,
		userId: string | null,
	): Promise<CredentialCheckStatus['status']> {
		// Only the system resolver keys on an n8n user, so it is the only one this
		// gate can answer for; anything else is reported as unresolvable here.
		if (resolverId !== SYSTEM_RESOLVER_ID) return 'resolver_missing';
		if (userId === null) return 'missing';

		const data = await this.userEntryStorage.getCredentialData(
			credentialId,
			userId,
			resolverId,
			{},
		);
		return data === null ? 'missing' : 'configured';
	}

	private async resolveCaller(
		executionContext: { credentials?: string },
		workflowId: string,
	): Promise<{
		userId: string;
		authorizationHeader: string;
		source: string;
		resource?: string;
	} | null> {
		if (!executionContext.credentials) return null;

		try {
			const context = toCredentialContext(
				await this.cipher.decryptV2(executionContext.credentials),
			);
			const source = context.metadata?.source;
			const resource = context.metadata?.resource;
			const userId = await this.resolveUserId(context);
			if (userId === null) return null;
			return {
				userId,
				authorizationHeader: `Bearer ${context.identity.replace(/^Bearer\s+/i, '')}`,
				source: typeof source === 'string' ? source : 'manual-execution',
				...(typeof resource === 'string' ? { resource } : {}),
			};
		} catch (error) {
			this.logger.debug('Could not identify the user behind a credential-status check', {
				workflowId,
				error,
			});
			return null;
		}
	}

	/**
	 * Same identity rule as `CredentialResolverService`: an MCP client presents an
	 * instance-issued OAuth token (`n8n-oauth`), everything else an auth cookie.
	 */
	private async resolveUserId(context: ICredentialContext): Promise<string | null> {
		if (context.metadata?.source === 'n8n-oauth') {
			const resource = context.metadata.resource;
			const { user } = await this.oauthTokenVerifier.verifyOAuthAccessToken(
				context.identity,
				typeof resource === 'string' ? resource : undefined,
			);
			return user?.id ?? null;
		}
		return await this.n8nIdentifier.resolve(context, {});
	}
}
