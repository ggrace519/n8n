import type { LockService, Logger } from '@n8n/backend-common';
import type { GlobalConfig } from '@n8n/config';
import type {
	CredentialsEntity,
	CredentialsRepository,
	User,
	WorkflowEntity,
	WorkflowRepository,
} from '@n8n/db';
import { mock } from 'vitest-mock-extended';

import type { CredentialsFinderService } from '@/credentials/credentials-finder.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { NotFoundError } from '@/errors/response-errors/not-found.error';
import type { OAuthBrowserBindingService } from '@/oauth/oauth-browser-binding.service';
import type { OauthService } from '@/oauth/oauth.service';
import type { WorkflowFinderService } from '@/workflows/workflow-finder.service';
import type { Request, Response } from 'express';
import type { CacheService } from '@/services/cache/cache.service';
import type { UrlService } from '@/services/url.service';

import { SYSTEM_RESOLVER_ID } from '../../constants';
import type { DynamicCredentialEntryStorage } from '../../credential-resolvers/storage/dynamic-credential-entry-storage';
import type { DynamicCredentialUserEntryStorage } from '../../credential-resolvers/storage/dynamic-credential-user-entry-storage';
import type { CredentialResolverService } from '../credential-resolver.service';
import type { CredentialResolverWorkflowService } from '../credential-resolver-workflow.service';
import { DynamicCredentialAuthorizationService } from '../dynamic-credential-authorization.service';

const browser = { req: mock<Request>(), res: mock<Response>() };
const EXTERNAL = { kind: 'external' as const, authorizationHeader: 'Bearer ext-token' };
const user = mock<User>({ id: 'user-1' });
const USER = { kind: 'user' as const, user, cookieToken: 'cookie-jwt' };

// A plain object, not mock(): a deep mock answers `resolverId` with a function, not null.
const credential = {
	id: 'cred-1',
	name: 'Calendar',
	type: 'oAuth2Api',
	isResolvable: true,
	resolverId: null,
} as unknown as CredentialsEntity;

const workflowUsing = (resolverId?: string) =>
	({
		id: 'wf-1',
		nodes: [{ credentials: { oAuth2Api: { id: 'cred-1', name: 'Calendar' } } }],
		settings: resolverId ? { credentialResolverId: resolverId } : {},
	}) as unknown as WorkflowEntity;

const setup = () => {
	const cache = new Map<string, unknown>();
	const cacheService = mock<CacheService>();
	cacheService.set.mockImplementation(async (key, value) => {
		cache.set(key, value);
	});
	cacheService.get.mockImplementation(async (key) => cache.get(key) as never);
	cacheService.delete.mockImplementation(async (key) => {
		cache.delete(key);
	});

	const lockService = mock<LockService>();
	lockService.withLease.mockImplementation(
		async (_ns, _key, fn) => await fn(new AbortController().signal),
	);

	const deps = {
		globalConfig: mock<GlobalConfig>({ endpoints: { rest: 'rest' } }),
		urlService: mock<UrlService>(),
		lockService,
		oauthService: mock<OauthService>(),
		browserBindingService: mock<OAuthBrowserBindingService>(),
		credentialsFinderService: mock<CredentialsFinderService>(),
		workflowFinderService: mock<WorkflowFinderService>(),
		credentialsRepository: mock<CredentialsRepository>(),
		workflowRepository: mock<WorkflowRepository>(),
		resolverWorkflowService: mock<CredentialResolverWorkflowService>(),
		resolverService: mock<CredentialResolverService>(),
		userEntryStorage: mock<DynamicCredentialUserEntryStorage>(),
		entryStorage: mock<DynamicCredentialEntryStorage>(),
	};
	deps.urlService.getInstanceBaseUrl.mockReturnValue('https://n8n.example.com');
	deps.credentialsRepository.findOneBy.mockResolvedValue(credential);
	deps.credentialsFinderService.findCredentialForUser.mockResolvedValue(credential);
	deps.resolverService.resolveExternalSubject.mockResolvedValue('sub-ext');
	deps.oauthService.generateAOauth2AuthUri.mockResolvedValue('https://idp.example.com/auth?x=1');
	deps.browserBindingService.ensureBindingCookie.mockReturnValue('nonce');
	deps.browserBindingService.computeHash.mockReturnValue('binding-hash');
	// resolver-1 is selected by a workflow that uses cred-1.
	deps.resolverWorkflowService.findAffectedWorkflows.mockResolvedValue([
		{ id: 'wf-1', name: 'wf' },
	]);
	deps.workflowRepository.findByIds.mockResolvedValue([workflowUsing('resolver-1')]);
	deps.workflowFinderService.findWorkflowForUser.mockImplementation(async () => null);

	const service = new DynamicCredentialAuthorizationService(
		mock<Logger>(),
		deps.globalConfig,
		deps.urlService,
		cacheService,
		deps.lockService,
		deps.oauthService,
		deps.browserBindingService,
		deps.credentialsFinderService,
		deps.workflowFinderService,
		deps.credentialsRepository,
		deps.workflowRepository,
		deps.resolverWorkflowService,
		deps.resolverService,
		deps.userEntryStorage,
		deps.entryStorage,
	);
	return { service, ...deps };
};

describe('DynamicCredentialAuthorizationService', () => {
	describe('getExecutionStatus', () => {
		it('reports a missing external credential with authorize and revoke URLs from the configured base', async () => {
			const { service, workflowRepository, credentialsRepository, entryStorage } = setup();
			workflowRepository.findById.mockResolvedValue(workflowUsing('resolver-1'));
			credentialsRepository.getManyByIds.mockResolvedValue([credential]);
			entryStorage.getCredentialData.mockResolvedValue(null);

			const status = await service.getExecutionStatus('wf-1', EXTERNAL);

			expect(status.readyToExecute).toBe(false);
			expect(status.credentials).toEqual([
				expect.objectContaining({
					credentialId: 'cred-1',
					credentialStatus: 'missing',
					authorizationUrl:
						'https://n8n.example.com/rest/credentials/cred-1/authorize?resolverId=resolver-1',
					revokeUrl: 'https://n8n.example.com/rest/credentials/cred-1/revoke?resolverId=resolver-1',
				}),
			]);
			// Looked up under the verified subject, never the raw token.
			expect(entryStorage.getCredentialData).toHaveBeenCalledWith(
				'cred-1',
				'sub-ext',
				'resolver-1',
				{},
			);
		});

		it('is ready once every credential is configured for the caller', async () => {
			const { service, workflowFinderService, credentialsRepository, userEntryStorage } = setup();
			workflowFinderService.findWorkflowForUser.mockResolvedValue(workflowUsing());
			credentialsRepository.getManyByIds.mockResolvedValue([credential]);
			userEntryStorage.getCredentialData.mockResolvedValue('encrypted');

			const status = await service.getExecutionStatus('wf-1', USER);

			expect(status.readyToExecute).toBe(true);
			expect(status.credentials?.[0]).toMatchObject({
				credentialStatus: 'configured',
				authorizationUrl: expect.stringContaining(
					'/rest/credentials/cred-1/authorize?resolverId=system-n8n',
				),
				revokeUrl: expect.stringContaining('/rest/credentials/cred-1/revoke?resolverId=system-n8n'),
			});
		});

		it('hides a workflow not set up for external users from an external caller', async () => {
			const { service, workflowRepository, credentialsRepository } = setup();
			workflowRepository.findById.mockResolvedValue(workflowUsing());
			credentialsRepository.getManyByIds.mockResolvedValue([credential]);

			await expect(service.getExecutionStatus('wf-1', EXTERNAL)).rejects.toThrow(NotFoundError);
		});

		it('reports resolver_missing to a signed-in user for an external-resolver credential', async () => {
			const { service, workflowFinderService, credentialsRepository } = setup();
			workflowFinderService.findWorkflowForUser.mockResolvedValue(workflowUsing('resolver-1'));
			credentialsRepository.getManyByIds.mockResolvedValue([credential]);

			const status = await service.getExecutionStatus('wf-1', USER);

			expect(status.credentials?.[0].credentialStatus).toBe('resolver_missing');
		});

		it("404s a signed-in user for a workflow they can't read", async () => {
			const { service, workflowFinderService, workflowRepository } = setup();
			workflowFinderService.findWorkflowForUser.mockResolvedValue(null);
			workflowRepository.findById.mockResolvedValue(workflowUsing());

			await expect(service.getExecutionStatus('wf-1', USER)).rejects.toThrow(NotFoundError);
			expect(workflowFinderService.findWorkflowForUser).toHaveBeenCalledWith('wf-1', user, [
				'workflow:read',
			]);
		});

		it('checks workflow access for the session behind an external request', async () => {
			const { service, workflowFinderService } = setup();
			workflowFinderService.findWorkflowForUser.mockResolvedValue(null);

			await expect(
				service.getExecutionStatus('wf-1', { ...EXTERNAL, sessionUser: user }),
			).rejects.toThrow(NotFoundError);
		});
	});

	describe('startAuthorization', () => {
		it('starts an external flow only after verifying the caller, without a userId in the state', async () => {
			const { service, resolverService, oauthService } = setup();

			await expect(service.startAuthorization('cred-1', 'resolver-1', EXTERNAL)).resolves.toBe(
				'https://idp.example.com/auth?x=1',
			);
			expect(resolverService.resolveExternalSubject).toHaveBeenCalledWith(
				'resolver-1',
				'Bearer ext-token',
				'cred-1',
			);
			const [, csrf] = oauthService.generateAOauth2AuthUri.mock.calls[0];
			expect(csrf).toMatchObject({
				origin: 'dynamic-credential',
				credentialResolverId: 'resolver-1',
				authorizationHeader: 'Bearer ext-token',
			});
			expect(csrf).not.toHaveProperty('userId');
		});

		it('refuses an external caller on the n8n resolver and a session user on another', async () => {
			const { service } = setup();

			await expect(
				service.startAuthorization('cred-1', SYSTEM_RESOLVER_ID, EXTERNAL),
			).rejects.toThrow(BadRequestError);
			await expect(service.startAuthorization('cred-1', 'resolver-1', USER)).rejects.toThrow(
				BadRequestError,
			);
		});

		it('refuses a resolver that does not serve the credential', async () => {
			const { service, resolverWorkflowService } = setup();
			resolverWorkflowService.findAffectedWorkflows.mockResolvedValue([]);

			await expect(service.startAuthorization('cred-1', 'resolver-x', EXTERNAL)).rejects.toThrow(
				BadRequestError,
			);
		});

		it('still requires credential:connect when an external request carries a session', async () => {
			const { service, credentialsFinderService } = setup();
			credentialsFinderService.findCredentialForUser.mockResolvedValue(null);

			await expect(
				service.startAuthorization('cred-1', 'resolver-1', { ...EXTERNAL, sessionUser: user }),
			).rejects.toThrow(NotFoundError);
			expect(credentialsFinderService.findCredentialForUser).toHaveBeenCalledWith('cred-1', user, [
				'credential:connect',
			]);
		});

		it('binds a browser-started flow to that browser', async () => {
			const { service, oauthService } = setup();

			await service.startAuthorization('cred-1', SYSTEM_RESOLVER_ID, USER, browser);

			const [, csrf] = oauthService.generateAOauth2AuthUri.mock.calls[0];
			expect(csrf).toMatchObject({ bindingHash: 'binding-hash', userId: 'user-1' });
		});

		it('404s for a credential that is not end-user (resolvable)', async () => {
			const { service, credentialsRepository } = setup();
			credentialsRepository.findOneBy.mockResolvedValue(
				mock<CredentialsEntity>({ id: 'cred-1', isResolvable: false }),
			);

			await expect(service.startAuthorization('cred-1', 'resolver-1', EXTERNAL)).rejects.toThrow(
				NotFoundError,
			);
		});
	});

	describe('authorize links', () => {
		const link = {
			credentialId: 'cred-1',
			resolverId: 'resolver-1',
			authorizationHeader: 'Bearer ext-token',
			source: 'external',
		};

		it('mints a link without the Bearer token in it and starts the flow once', async () => {
			const { service } = setup();

			const url = await service.issueAuthorizeLink(link);
			expect(url).toMatch(
				/^https:\/\/n8n\.example\.com\/rest\/credentials\/cred-1\/authorize\?token=/,
			);
			expect(url).not.toContain('ext-token');

			const token = new URL(url).searchParams.get('token')!;
			await expect(service.consumeAuthorizeLink('cred-1', token, browser)).resolves.toBe(
				'https://idp.example.com/auth?x=1',
			);
			await expect(service.consumeAuthorizeLink('cred-1', token, browser)).rejects.toThrow(
				NotFoundError,
			);
		});

		it('claims the link under a lease and binds the flow to the opening browser', async () => {
			const { service, lockService, oauthService } = setup();
			const token = new URL(await service.issueAuthorizeLink(link)).searchParams.get('token')!;

			await service.consumeAuthorizeLink('cred-1', token, browser);

			expect(lockService.withLease).toHaveBeenCalled();
			const [, csrf] = oauthService.generateAOauth2AuthUri.mock.calls[0];
			expect(csrf).toMatchObject({
				bindingHash: 'binding-hash',
				authMetadata: { source: 'external' },
			});
		});

		it('hands the token resource of an n8n-oauth link on to the OAuth callback', async () => {
			const { service, oauthService } = setup();
			const token = new URL(
				await service.issueAuthorizeLink({
					...link,
					resolverId: SYSTEM_RESOLVER_ID,
					source: 'n8n-oauth',
					resource: 'https://n8n.example.com/webhook/p',
					userId: 'user-1',
				}),
			).searchParams.get('token')!;

			await service.consumeAuthorizeLink('cred-1', token, browser, user);

			const [, csrf] = oauthService.generateAOauth2AuthUri.mock.calls[0];
			expect(csrf).toMatchObject({
				authMetadata: { source: 'n8n-oauth', resource: 'https://n8n.example.com/webhook/p' },
			});
		});

		it('only lets the n8n user a link was minted for open it', async () => {
			const { service } = setup();
			const userLink = {
				...link,
				resolverId: SYSTEM_RESOLVER_ID,
				source: 'n8n-oauth',
				userId: 'user-1',
			};
			const tokenFor = async () =>
				new URL(await service.issueAuthorizeLink(userLink)).searchParams.get('token')!;

			const other = { id: 'user-2' } as User;
			await expect(
				service.consumeAuthorizeLink('cred-1', await tokenFor(), browser, other),
			).rejects.toThrow(NotFoundError);
			await expect(
				service.consumeAuthorizeLink('cred-1', await tokenFor(), browser),
			).rejects.toThrow(NotFoundError);
			await expect(
				service.consumeAuthorizeLink('cred-1', await tokenFor(), browser, user),
			).resolves.toBe('https://idp.example.com/auth?x=1');
		});

		it('refuses a non-n8n resolver link whose identity is not external', async () => {
			const { service, resolverService } = setup();
			const token = new URL(
				await service.issueAuthorizeLink({ ...link, source: 'manual-execution' }),
			).searchParams.get('token')!;

			await expect(service.consumeAuthorizeLink('cred-1', token, browser)).rejects.toThrow(
				NotFoundError,
			);
			expect(resolverService.resolveExternalSubject).not.toHaveBeenCalled();
		});

		it('refuses a link presented for a different credential', async () => {
			const { service } = setup();
			const token = new URL(await service.issueAuthorizeLink(link)).searchParams.get('token')!;

			await expect(service.consumeAuthorizeLink('cred-2', token, browser)).rejects.toThrow(
				NotFoundError,
			);
		});
	});

	describe('revoke', () => {
		it("removes only the external caller's own entry", async () => {
			const { service, entryStorage, userEntryStorage } = setup();

			await service.revoke('cred-1', 'resolver-1', EXTERNAL);

			expect(entryStorage.deleteCredentialData).toHaveBeenCalledWith(
				'cred-1',
				'sub-ext',
				'resolver-1',
				{},
			);
			expect(userEntryStorage.deleteCredentialData).not.toHaveBeenCalled();
		});

		it("removes only the session user's own entry", async () => {
			const { service, userEntryStorage } = setup();

			await service.revoke('cred-1', SYSTEM_RESOLVER_ID, USER);

			expect(userEntryStorage.deleteCredentialData).toHaveBeenCalledWith(
				'cred-1',
				'user-1',
				SYSTEM_RESOLVER_ID,
				{},
			);
		});
	});
});
