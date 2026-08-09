import type { ProvisioningConfigDto } from '@n8n/api-types';
import type { Logger } from '@n8n/backend-common';
import type { OutboundHttp } from '@n8n/backend-network';
import type { GlobalConfig, SsrfProtectionConfig } from '@n8n/config';
import type {
	AuthIdentity,
	AuthIdentityRepository,
	Settings,
	SettingsRepository,
	User,
	UserRepository,
} from '@n8n/db';
import type { Response } from 'express';
import type { Cipher } from 'n8n-core';
import { createHash } from 'node:crypto';
import * as client from 'openid-client';
import { mock } from 'vitest-mock-extended';

import type { AuthService } from '@/auth/auth.service';
import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import type { ProvisioningService } from '@/modules/provisioning/provisioning.service';
import type { AuthlessRequest } from '@/requests';
import type { PasswordUtility } from '@/services/password.utility';
import type { UrlService } from '@/services/url.service';
import * as ssoHelpers from '@/sso/sso-helpers';

import {
	OIDC_CLIENT_SECRET_REDACTED_VALUE,
	OIDC_NONCE_COOKIE_NAME,
	OIDC_PKCE_COOKIE_NAME,
	OIDC_PREFERENCES_DB_KEY,
	OIDC_STATE_COOKIE_NAME,
} from '../constants';
import { OidcService } from '../oidc.service';

vi.mock('openid-client', () => ({
	customFetch: Symbol('customFetch'),
	discovery: vi.fn(),
	buildAuthorizationUrl: vi.fn(),
	authorizationCodeGrant: vi.fn(),
	fetchUserInfo: vi.fn(),
	buildEndSessionUrl: vi.fn(),
	randomState: vi.fn(() => 'test-state'),
	randomNonce: vi.fn(() => 'test-nonce'),
	randomPKCECodeVerifier: vi.fn(() => 'test-verifier'),
	calculatePKCECodeChallenge: vi.fn(async () => 'test-challenge'),
	allowInsecureRequests: vi.fn(),
}));

vi.mock('@/sso/sso-helpers', () => ({
	assertAuthenticationMethodCanBeEnabled: vi.fn(),
	getCurrentAuthenticationMethod: vi.fn(() => 'email'),
	setCurrentAuthenticationMethod: vi.fn(),
}));

const storedRow = (config: Record<string, unknown>): Settings =>
	({
		key: OIDC_PREFERENCES_DB_KEY,
		value: JSON.stringify(config),
		loadOnStartup: true,
	}) as Settings;

const TEST_ISSUER = 'https://idp.example.com';

/** Mirrors the service's issuer-scoped `AuthIdentity.providerId` encoding. */
const providerIdFor = (issuer: string, sub: string) => {
	const issuerDigest = createHash('sha256').update(issuer).digest('hex');
	return `oidc:v1:${createHash('sha256')
		.update(issuerDigest + sub)
		.digest('base64url')}`;
};

const disabledProvisioningConfig: ProvisioningConfigDto = {
	scopesProvisionInstanceRole: false,
	scopesProvisionProjectRoles: false,
	scopesUseExpressionMapping: false,
	scopesName: 'n8n',
	scopesInstanceRoleClaimName: 'n8n_instance_role',
	scopesProjectsRolesClaimName: 'n8n_project_roles',
};

const validStoredConfig = {
	clientId: 'client-id',
	clientSecret: 'encrypted-secret',
	discoveryEndpoint: 'https://idp.example.com/.well-known/openid-configuration',
	loginEnabled: true,
	prompt: 'select_account',
	authenticationContextClassReference: [],
	additionalScopes: '',
	emailVerifiedRequired: false,
	rpInitiatedLogoutEnabled: false,
};

describe('OidcService', () => {
	const logger = mock<Logger>();
	const settingsRepository = mock<SettingsRepository>();
	const authIdentityRepository = mock<AuthIdentityRepository>();
	const userRepository = mock<UserRepository>();
	const cipher = mock<Cipher>();
	const outboundHttp = mock<OutboundHttp>();
	const urlService = mock<UrlService>();
	const authService = mock<AuthService>({ jwtExpiration: 3600 });
	const passwordUtility = mock<PasswordUtility>();
	const provisioningService = mock<ProvisioningService>();

	const trxManager = { save: vi.fn(), create: vi.fn() };

	let globalConfig: GlobalConfig;
	let service: OidcService;

	const flowCookies = {
		[OIDC_STATE_COOKIE_NAME]: 'test-state',
		[OIDC_NONCE_COOKIE_NAME]: 'test-nonce',
		[OIDC_PKCE_COOKIE_NAME]: 'test-verifier',
	};

	const callbackRequest = (cookies: Record<string, string> = flowCookies) =>
		mock<AuthlessRequest>({
			cookies,
			originalUrl: '/rest/sso/oidc/callback?code=auth-code&state=test-state',
		});

	beforeEach(() => {
		vi.clearAllMocks();

		globalConfig = {
			sso: {
				oidc: { loginEnabled: true },
				justInTimeProvisioning: true,
				provisioning: {
					scopesProvisionInstanceRole: false,
					scopesProvisionProjectRoles: false,
					scopesName: 'n8n',
				},
			},
			endpoints: { rest: 'rest' },
			auth: { cookie: { secure: true, samesite: 'lax' } },
		} as GlobalConfig;

		service = new OidcService(
			logger,
			globalConfig,
			settingsRepository,
			authIdentityRepository,
			userRepository,
			cipher,
			outboundHttp,
			// SSRF protection is opt-in instance-wide; provider traffic follows it.
			mock<SsrfProtectionConfig>({ enabled: false }),
			mock(),
			urlService,
			authService,
			passwordUtility,
			provisioningService,
		);

		provisioningService.getProvisioningConfig.mockResolvedValue(disabledProvisioningConfig);
		provisioningService.resolveLoginProvisioning.mockResolvedValue({
			outcome: 'allow',
			provider: 'oidc',
			projectRoles: [],
			managedProjectIds: [],
		});
		provisioningService.applyLoginProvisioning.mockResolvedValue({
			instanceRoleChanged: false,
			projectsAdded: 0,
			projectsRemoved: 0,
		});

		settingsRepository.findByKey.mockResolvedValue(storedRow(validStoredConfig));
		cipher.decryptV2.mockResolvedValue('plain-secret');
		cipher.encryptV2.mockResolvedValue('re-encrypted-secret');
		urlService.getInstanceBaseUrl.mockReturnValue('http://localhost:5678');
		outboundHttp.transport.mockReturnValue({
			asCustomFetch: () => vi.fn(),
			getDispatcher: vi.fn(),
			getNodeAgent: vi.fn(),
		});
		vi.mocked(client.discovery).mockResolvedValue(
			mock<client.Configuration>({
				serverMetadata: () =>
					mock<ReturnType<client.Configuration['serverMetadata']>>({
						end_session_endpoint: 'https://idp.example.com/logout',
					}),
			}),
		);
		vi.mocked(client.buildAuthorizationUrl).mockImplementation(
			(_config, params) => new URL(`https://idp.example.com/auth?${params.toString()}`),
		);
		vi.mocked(ssoHelpers.getCurrentAuthenticationMethod).mockReturnValue('oidc');
		vi.mocked(ssoHelpers.assertAuthenticationMethodCanBeEnabled).mockImplementation(() => {});
		authIdentityRepository.findOne.mockResolvedValue(null);
		userRepository.findOne.mockResolvedValue(null);

		// `createUser` runs inside a transaction; run the unit of work inline.
		trxManager.save.mockResolvedValue(undefined);
		trxManager.create.mockImplementation((_entity: unknown, data: unknown) => data);
		Object.assign(userRepository, {
			manager: {
				transaction: async (run: (trx: typeof trxManager) => Promise<unknown>) =>
					await run(trxManager),
			},
		});
	});

	describe('loadConfig', () => {
		it('returns defaults when no configuration is stored', async () => {
			settingsRepository.findByKey.mockResolvedValue(null);

			const config = await service.loadConfig();

			expect(config.clientId).toBe('');
			expect(config.clientSecret).toBe('');
			expect(config.loginEnabled).toBe(false);
			expect(config.prompt).toBe('select_account');
			expect(config.authenticationContextClassReference).toEqual([]);
			expect(config.discoveryEndpoint).toBeInstanceOf(URL);
		});

		it('redacts the client secret unless explicitly requested', async () => {
			const redacted = await service.loadConfig();
			expect(redacted.clientSecret).toBe(OIDC_CLIENT_SECRET_REDACTED_VALUE);

			const withSecret = await service.loadConfig(true);
			expect(withSecret.clientSecret).toBe('plain-secret');
			expect(cipher.decryptV2).toHaveBeenCalledWith('encrypted-secret');
		});
	});

	describe('updateConfig', () => {
		const validUpdate = {
			clientId: 'client-id',
			clientSecret: 'new-secret',
			discoveryEndpoint: 'https://idp.example.com/.well-known/openid-configuration',
			loginEnabled: false,
			prompt: 'select_account' as const,
			authenticationContextClassReference: [],
			additionalScopes: '',
			emailVerifiedRequired: false,
			rpInitiatedLogoutEnabled: false,
		};

		it('rejects the redaction sentinel when no secret is stored', async () => {
			settingsRepository.findByKey.mockResolvedValue(null);

			await expect(
				service.updateConfig({ ...validUpdate, clientSecret: OIDC_CLIENT_SECRET_REDACTED_VALUE }),
			).rejects.toThrowError(BadRequestError);
			expect(settingsRepository.upsertByKey).not.toHaveBeenCalled();
		});

		it('keeps the stored secret when the redaction sentinel is submitted', async () => {
			await service.updateConfig({
				...validUpdate,
				clientSecret: OIDC_CLIENT_SECRET_REDACTED_VALUE,
			});

			expect(cipher.decryptV2).toHaveBeenCalledWith('encrypted-secret');
			expect(cipher.encryptV2).toHaveBeenCalledWith('plain-secret');
			const persisted = JSON.parse(settingsRepository.upsertByKey.mock.calls[0][1]) as Record<
				string,
				unknown
			>;
			expect(persisted.clientSecret).toBe('re-encrypted-secret');
		});

		it('validates the provider via discovery with the submitted values', async () => {
			await service.updateConfig(validUpdate);

			expect(client.discovery).toHaveBeenCalledWith(
				new URL(validUpdate.discoveryEndpoint),
				'client-id',
				'new-secret',
				undefined,
				expect.anything(),
			);
		});

		it('rejects with 400 when discovery fails, without persisting', async () => {
			vi.mocked(client.discovery).mockRejectedValue(new Error('connection refused'));

			await expect(service.updateConfig(validUpdate)).rejects.toThrowError(BadRequestError);
			expect(settingsRepository.upsertByKey).not.toHaveBeenCalled();
		});

		it('rejects enabling OIDC while another SSO method is active', async () => {
			vi.mocked(ssoHelpers.assertAuthenticationMethodCanBeEnabled).mockImplementation(() => {
				throw new Error('Cannot enable oidc login while saml login is active. Disable saml first.');
			});

			await expect(
				service.updateConfig({ ...validUpdate, loginEnabled: true }),
			).rejects.toThrowError(expect.objectContaining({ message: expect.stringContaining('saml') }));
			expect(settingsRepository.upsertByKey).not.toHaveBeenCalled();
		});

		it('persists and switches the authentication method when enabling login', async () => {
			await service.updateConfig({ ...validUpdate, loginEnabled: true });

			expect(settingsRepository.upsertByKey).toHaveBeenCalledWith(
				OIDC_PREFERENCES_DB_KEY,
				expect.any(String),
				true,
				{},
			);
			expect(globalConfig.sso.oidc.loginEnabled).toBe(true);
			expect(ssoHelpers.setCurrentAuthenticationMethod).toHaveBeenCalledWith('oidc');
		});

		it('falls back to email when disabling login while OIDC is active', async () => {
			await service.updateConfig({ ...validUpdate, loginEnabled: false });

			expect(globalConfig.sso.oidc.loginEnabled).toBe(false);
			expect(ssoHelpers.setCurrentAuthenticationMethod).toHaveBeenCalledWith('email');
		});
	});

	describe('createAuthorizationUrl', () => {
		it('generates state, nonce and PKCE values and stores them in flow cookies', async () => {
			const res = mock<Response>();

			const url = await service.createAuthorizationUrl(res);

			const parsed = new URL(url);
			expect(parsed.searchParams.get('state')).toBe('test-state');
			expect(parsed.searchParams.get('nonce')).toBe('test-nonce');
			expect(parsed.searchParams.get('code_challenge')).toBe('test-challenge');
			expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
			expect(parsed.searchParams.get('redirect_uri')).toBe(
				'http://localhost:5678/rest/sso/oidc/callback',
			);

			expect(res.cookie).toHaveBeenCalledWith(
				OIDC_STATE_COOKIE_NAME,
				'test-state',
				expect.objectContaining({ httpOnly: true, sameSite: 'lax' }),
			);
			expect(res.cookie).toHaveBeenCalledWith(
				OIDC_NONCE_COOKIE_NAME,
				'test-nonce',
				expect.anything(),
			);
			expect(res.cookie).toHaveBeenCalledWith(
				OIDC_PKCE_COOKIE_NAME,
				'test-verifier',
				expect.anything(),
			);
		});

		it('includes base scopes, additional scopes and ACR values', async () => {
			settingsRepository.findByKey.mockResolvedValue(
				storedRow({
					...validStoredConfig,
					additionalScopes: 'groups offline_access',
					authenticationContextClassReference: ['mfa', 'phrh'],
				}),
			);

			const url = await service.createAuthorizationUrl(mock<Response>());

			const parsed = new URL(url);
			expect(parsed.searchParams.get('scope')).toBe('openid profile email groups offline_access');
			expect(parsed.searchParams.get('acr_values')).toBe('mfa phrh');
		});

		// The scope must follow the persisted provisioning policy, the same source
		// login-time evaluation reads — otherwise enabling a role claim through the
		// config endpoint would never request the scope that carries it.
		it('requests the provisioning scope when claim provisioning is enabled', async () => {
			provisioningService.getProvisioningConfig.mockResolvedValue({
				...disabledProvisioningConfig,
				scopesProvisionInstanceRole: true,
			});

			const url = await service.createAuthorizationUrl(mock<Response>());

			expect(new URL(url).searchParams.get('scope')).toBe('openid profile email n8n');
		});

		it('does not request the provisioning scope from stale instance config', async () => {
			globalConfig.sso.provisioning.scopesProvisionInstanceRole = true;

			const url = await service.createAuthorizationUrl(mock<Response>());

			expect(new URL(url).searchParams.get('scope')).toBe('openid profile email');
		});

		it('rejects when OIDC is not configured', async () => {
			settingsRepository.findByKey.mockResolvedValue(null);

			await expect(service.createAuthorizationUrl(mock<Response>())).rejects.toThrowError(
				BadRequestError,
			);
		});

		it('registers a single-use pending test state for connection tests', async () => {
			await service.createAuthorizationUrl(mock<Response>(), { connectionTest: true });

			expect(service.consumePendingTestCallback(callbackRequest())).toBe(true);
			// Consumed exactly once.
			expect(service.consumePendingTestCallback(callbackRequest())).toBe(false);
		});

		it('does not mark normal logins as pending tests', async () => {
			await service.createAuthorizationUrl(mock<Response>());

			expect(service.consumePendingTestCallback(callbackRequest())).toBe(false);
		});
	});

	describe('callback token exchange', () => {
		const idTokenClaims = {
			iss: TEST_ISSUER,
			sub: 'subject-1',
			email: 'userinfo@example.com',
			given_name: 'Claims',
			family_name: 'Person',
		};
		const userInfo = {
			sub: 'subject-1',
			email: 'userinfo@example.com',
			email_verified: true,
			given_name: 'User',
			family_name: 'Info',
		};

		const mockTokens = (overrides: { claims?: unknown; idToken?: string } = {}) => {
			vi.mocked(client.authorizationCodeGrant).mockResolvedValue({
				access_token: 'access-token',
				id_token: overrides.idToken ?? 'id-token',
				token_type: 'bearer',
				claims: () => ('claims' in overrides ? overrides.claims : idTokenClaims),
			} as unknown as Awaited<ReturnType<typeof client.authorizationCodeGrant>>);
			vi.mocked(client.fetchUserInfo).mockResolvedValue(
				userInfo as unknown as client.UserInfoResponse,
			);
		};

		/** A user whose stored names already match the provider's, so no name write occurs. */
		const resolvedUser = (id: string, email?: string) =>
			mock<User>({ id, email, firstName: 'User', lastName: 'Info' });

		const mockUserResolution = () => {
			const user = mock<User>({ id: 'user-1', firstName: 'User', lastName: 'Info' });
			authIdentityRepository.findOne.mockResolvedValue(
				mock<Awaited<ReturnType<AuthIdentityRepository['findOne']>>>({ user }),
			);
			return user;
		};

		/** Resolves the issuer-scoped identity only; every other lookup misses. */
		const mockIssuerScopedIdentity = (user: User, issuer = TEST_ISSUER, sub = 'subject-1') => {
			const providerId = providerIdFor(issuer, sub);
			authIdentityRepository.findOne.mockImplementation(async (options) => {
				const where = (options as { where?: { providerId?: string } }).where;
				return where?.providerId === providerId ? mock<AuthIdentity>({ user, providerId }) : null;
			});
			return providerId;
		};

		it('rejects when the flow cookies are missing', async () => {
			mockTokens();
			const res = mock<Response>();

			await expect(service.runLoginCallback(callbackRequest({}), res)).rejects.toThrowError(
				AuthError,
			);
			expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
		});

		it('clears the single-use flow cookies before validating', async () => {
			mockTokens();
			mockUserResolution();
			const res = mock<Response>();

			await service.runLoginCallback(callbackRequest(), res);

			expect(res.clearCookie).toHaveBeenCalledWith(OIDC_STATE_COOKIE_NAME, expect.anything());
			expect(res.clearCookie).toHaveBeenCalledWith(OIDC_NONCE_COOKIE_NAME, expect.anything());
			expect(res.clearCookie).toHaveBeenCalledWith(OIDC_PKCE_COOKIE_NAME, expect.anything());
		});

		it('passes the cookie state, nonce and PKCE verifier to the token exchange', async () => {
			mockTokens();
			mockUserResolution();

			await service.runLoginCallback(callbackRequest(), mock<Response>());

			expect(client.authorizationCodeGrant).toHaveBeenCalledWith(
				expect.anything(),
				new URL('http://localhost:5678/rest/sso/oidc/callback?code=auth-code&state=test-state'),
				{
					expectedState: 'test-state',
					expectedNonce: 'test-nonce',
					pkceCodeVerifier: 'test-verifier',
					idTokenExpected: true,
				},
			);
		});

		it('rejects when login is not enabled', async () => {
			globalConfig.sso.oidc.loginEnabled = false;

			await expect(
				service.runLoginCallback(callbackRequest(), mock<Response>()),
			).rejects.toThrowError(AuthError);
		});

		it('rejects when the ID token has no subject', async () => {
			mockTokens({ claims: undefined });

			await expect(
				service.runLoginCallback(callbackRequest(), mock<Response>()),
			).rejects.toThrowError(AuthError);
			expect(client.fetchUserInfo).not.toHaveBeenCalled();
		});

		it('propagates token-exchange failures on normal logins', async () => {
			vi.mocked(client.authorizationCodeGrant).mockRejectedValue(
				new Error('invalid authorization response'),
			);

			await expect(
				service.runLoginCallback(callbackRequest(), mock<Response>()),
			).rejects.toThrowError('invalid authorization response');
		});

		it('renders a failure page (never throws) for failed connection tests', async () => {
			vi.mocked(client.authorizationCodeGrant).mockRejectedValue(new Error('bad state'));

			const html = await service.runConnectionTestCallback(callbackRequest(), mock<Response>());

			expect(html).toContain('OIDC Connection Test failed');
			expect(html).toContain('bad state');
		});

		it('renders the success page with the userinfo attributes', async () => {
			mockTokens();

			const html = await service.runConnectionTestCallback(callbackRequest(), mock<Response>());

			expect(html).toContain('OIDC Connection Test was successful');
			expect(html).toContain('userinfo@example.com');
		});

		describe('claim mapping', () => {
			it('resolves the identity by the issuer-scoped subject', async () => {
				mockTokens();
				const user = resolvedUser('user-1');
				const providerId = mockIssuerScopedIdentity(user);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe(user.id);
				expect(authIdentityRepository.findOne).toHaveBeenCalledWith({
					where: { providerId, providerType: 'oidc' },
					relations: { user: { role: true } },
				});
			});

			it('falls back to the ID-token email when userinfo has none', async () => {
				mockTokens({ claims: { ...idTokenClaims, email: 'claims@example.com' } });
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
				} as unknown as client.UserInfoResponse);
				authIdentityRepository.findOne.mockResolvedValue(null);
				userRepository.findOne.mockResolvedValue(null);
				globalConfig.sso.justInTimeProvisioning = false;

				// JIT is disabled, so hitting the JIT rejection proves the claims
				// email passed validation and resolution was attempted.
				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError('just-in-time provisioning is disabled');
				expect(userRepository.findOne).toHaveBeenCalledWith(
					expect.objectContaining({ where: { email: 'claims@example.com' } }),
				);
			});

			it('rejects when no email claim is present at all', async () => {
				mockTokens({ claims: { iss: TEST_ISSUER, sub: 'subject-1' } });
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
				} as unknown as client.UserInfoResponse);

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError('did not return an email address');
			});

			it('rejects when the ID token has no issuer', async () => {
				mockTokens({ claims: { sub: 'subject-1', email: 'userinfo@example.com' } });

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError('the ID token has no issuer');
			});

			it('rejects unverified emails when emailVerifiedRequired is set', async () => {
				settingsRepository.findByKey.mockResolvedValue(
					storedRow({ ...validStoredConfig, emailVerifiedRequired: true }),
				);
				mockTokens();
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
					email: 'userinfo@example.com',
					email_verified: false,
				} as unknown as client.UserInfoResponse);

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(ForbiddenError);
			});

			it('accepts verified emails when emailVerifiedRequired is set', async () => {
				settingsRepository.findByKey.mockResolvedValue(
					storedRow({ ...validStoredConfig, emailVerifiedRequired: true }),
				);
				mockTokens();
				const user = resolvedUser('user-1');
				mockIssuerScopedIdentity(user);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe(user.id);
			});
		});

		describe('claim source atomicity', () => {
			it('reads the verification flag from the document the email came from', async () => {
				settingsRepository.findByKey.mockResolvedValue(
					storedRow({ ...validStoredConfig, emailVerifiedRequired: true }),
				);
				// The ID token reports a verified address; userinfo supplies the
				// email but no flag. The flag must not carry across documents.
				mockTokens({
					claims: { ...idTokenClaims, email_verified: true },
				});
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
					email: 'userinfo@example.com',
				} as unknown as client.UserInfoResponse);

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(ForbiddenError);
			});

			it('uses the ID-token verification flag when the email comes from the ID token', async () => {
				settingsRepository.findByKey.mockResolvedValue(
					storedRow({ ...validStoredConfig, emailVerifiedRequired: true }),
				);
				mockTokens({ claims: { ...idTokenClaims, email_verified: true } });
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
				} as unknown as client.UserInfoResponse);
				// Only the ID token carries names here, so the account already holds them.
				const user = mock<User>({ id: 'user-1', firstName: 'Claims', lastName: 'Person' });
				mockIssuerScopedIdentity(user);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe(user.id);
			});

			it('rejects a login whose documents name different email addresses', async () => {
				mockTokens({ claims: { ...idTokenClaims, email: 'claims@example.com' } });

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError('conflicting email addresses');
				expect(userRepository.findOne).not.toHaveBeenCalled();
			});

			it('accepts email addresses that differ only in case', async () => {
				mockTokens({ claims: { ...idTokenClaims, email: 'UserInfo@Example.com' } });
				const user = resolvedUser('user-1');
				mockIssuerScopedIdentity(user);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe(user.id);
			});

			it('rejects a login whose documents name different subjects', async () => {
				mockTokens();
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'other-subject',
					email: 'userinfo@example.com',
					email_verified: true,
				} as unknown as client.UserInfoResponse);

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError('conflicting subjects');
				expect(userRepository.findOne).not.toHaveBeenCalled();
			});
		});

		describe('account matching by email', () => {
			const existingAccount = (overrides: Partial<User> = {}) =>
				mock<User>({
					...resolvedUser('existing-1', 'userinfo@example.com'),
					role: { slug: 'global:member' },
					authIdentities: [],
					...overrides,
				});

			it('attaches the identity to a matching account with a verified email', async () => {
				mockTokens();
				const user = existingAccount();
				userRepository.findOne.mockResolvedValue(user);

				await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(authIdentityRepository.create).toHaveBeenCalledWith(
					expect.objectContaining({
						providerId: providerIdFor(TEST_ISSUER, 'subject-1'),
						providerType: 'oidc',
						userId: 'existing-1',
					}),
				);
			});

			it('refuses to match an existing account on an unverified email', async () => {
				mockTokens();
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
					email: 'userinfo@example.com',
				} as unknown as client.UserInfoResponse);
				userRepository.findOne.mockResolvedValue(existingAccount());

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(AuthError);
				expect(authIdentityRepository.save).not.toHaveBeenCalled();
			});

			it.each(['global:owner', 'global:admin'])(
				'refuses to attach a first identity to a %s account',
				async (slug) => {
					mockTokens();
					userRepository.findOne.mockResolvedValue(existingAccount({ role: { slug } as never }));

					await expect(
						service.runLoginCallback(callbackRequest(), mock<Response>()),
					).rejects.toThrowError(AuthError);
					expect(authIdentityRepository.save).not.toHaveBeenCalled();
					expect(userRepository.save).not.toHaveBeenCalled();
				},
			);

			it('keeps the refusal message free of the asserted address', async () => {
				mockTokens();
				userRepository.findOne.mockResolvedValue(
					existingAccount({ role: { slug: 'global:owner' } as never }),
				);

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(/^OIDC login failed$/);
				const warned = logger.warn.mock.calls.map((call) => JSON.stringify(call)).join(' ');
				expect(warned).not.toContain('userinfo@example.com');
			});

			it('still attaches to a privileged account that already has an OIDC identity', async () => {
				mockTokens();
				userRepository.findOne.mockResolvedValue(
					existingAccount({
						role: { slug: 'global:admin' } as never,
						authIdentities: [mock<AuthIdentity>({ providerType: 'oidc' })],
					}),
				);

				await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(authIdentityRepository.save).toHaveBeenCalled();
			});

			it('creates a new account for an unverified email when verification is not required', async () => {
				mockTokens();
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
					email: 'userinfo@example.com',
				} as unknown as client.UserInfoResponse);
				userRepository.findOne.mockResolvedValue(null);
				userRepository.createUserWithProject.mockResolvedValue({
					user: mock<User>({ id: 'created-1' }),
				} as never);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe('created-1');
				expect(trxManager.create).toHaveBeenCalledWith(
					expect.anything(),
					expect.objectContaining({
						providerId: providerIdFor(TEST_ISSUER, 'subject-1'),
						providerType: 'oidc',
						userId: 'created-1',
					}),
				);
			});
		});

		describe('legacy subject-only identities', () => {
			const legacyRow = (user: User) => mock<AuthIdentity>({ providerId: 'subject-1', user });

			/** Only the pre-issuer-scoping row exists. */
			const mockLegacyOnly = (user: User) => {
				authIdentityRepository.findOne.mockImplementation(async (options) => {
					const where = (options as { where?: { providerId?: string } }).where;
					return where?.providerId === 'subject-1' ? legacyRow(user) : null;
				});
			};

			it('re-keys a subject-only row to the issuer-scoped value', async () => {
				mockTokens();
				const user = resolvedUser('legacy-1', 'userinfo@example.com');
				mockLegacyOnly(user);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe('legacy-1');
				expect(authIdentityRepository.update).toHaveBeenCalledWith(
					{ providerId: 'subject-1', providerType: 'oidc' },
					{ providerId: providerIdFor(TEST_ISSUER, 'subject-1') },
				);
			});

			it('re-keys only under the issuer that authenticated the login', async () => {
				mockTokens({ claims: { ...idTokenClaims, iss: 'https://other-idp.example.com' } });
				const user = resolvedUser('legacy-1', 'userinfo@example.com');
				mockLegacyOnly(user);

				await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(authIdentityRepository.update).toHaveBeenCalledWith(
					{ providerId: 'subject-1', providerType: 'oidc' },
					{ providerId: providerIdFor('https://other-idp.example.com', 'subject-1') },
				);
			});

			it('refuses to re-key a subject-only row onto a privileged account', async () => {
				mockTokens();
				const user = mock<User>({
					id: 'legacy-owner',
					email: 'userinfo@example.com',
					firstName: 'User',
					lastName: 'Info',
					role: { slug: 'global:owner' } as never,
				});
				mockLegacyOnly(user);

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(/^OIDC login failed$/);
				expect(authIdentityRepository.update).not.toHaveBeenCalled();
			});

			it('refuses to re-key a subject-only row on an unverified email', async () => {
				mockTokens();
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
					email: 'userinfo@example.com',
				} as unknown as client.UserInfoResponse);
				mockLegacyOnly(resolvedUser('legacy-1', 'userinfo@example.com'));

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(/^OIDC login failed$/);
				expect(authIdentityRepository.update).not.toHaveBeenCalled();
			});

			it('leaves a subject-only row alone when the stored account email differs', async () => {
				mockTokens();
				const user = resolvedUser('legacy-1', 'someone-else@example.com');
				mockLegacyOnly(user);
				userRepository.findOne.mockResolvedValue(null);
				globalConfig.sso.justInTimeProvisioning = false;

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError('just-in-time provisioning is disabled');
				expect(authIdentityRepository.update).not.toHaveBeenCalled();
			});

			it('prefers the issuer-scoped row over a subject-only row', async () => {
				mockTokens();
				const scoped = resolvedUser('scoped-1');
				mockIssuerScopedIdentity(scoped);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe('scoped-1');
				expect(authIdentityRepository.update).not.toHaveBeenCalled();
			});
		});

		describe('provisioning policy', () => {
			it.each([
				['access is blocked by the policy', 'block-access' as const],
				['the policy cannot be evaluated', 'evaluation-failed' as const],
			])('refuses the login when %s', async (_label, reason) => {
				provisioningService.resolveLoginProvisioning.mockResolvedValue({
					outcome: 'deny',
					reason,
				});
				mockTokens();
				mockUserResolution();

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(AuthError);
			});

			it('decides before any account lookup or mutation', async () => {
				provisioningService.resolveLoginProvisioning.mockResolvedValue({
					outcome: 'deny',
					reason: 'block-access',
				});
				mockTokens();

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError(AuthError);
				expect(authIdentityRepository.findOne).not.toHaveBeenCalled();
				expect(authIdentityRepository.save).not.toHaveBeenCalled();
				expect(userRepository.findOne).not.toHaveBeenCalled();
				expect(userRepository.save).not.toHaveBeenCalled();
				expect(userRepository.createUserWithProject).not.toHaveBeenCalled();
			});

			it('evaluates the policy against both claims documents', async () => {
				mockTokens();
				const user = resolvedUser('user-1');
				mockIssuerScopedIdentity(user);

				await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(provisioningService.resolveLoginProvisioning).toHaveBeenCalledWith(
					expect.objectContaining({
						provider: 'oidc',
						providerContext: expect.objectContaining({ provider: 'oidc' }),
					}),
				);
			});

			it('applies the decision to the account the login resolved to', async () => {
				mockTokens();
				const user = resolvedUser('user-1');
				mockIssuerScopedIdentity(user);

				await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(provisioningService.applyLoginProvisioning).toHaveBeenCalledWith(
					expect.objectContaining({ id: 'user-1' }),
					expect.objectContaining({ outcome: 'allow' }),
				);
			});

			it('admits the login when no provisioning is configured', async () => {
				mockTokens();
				const user = resolvedUser('user-1');
				mockIssuerScopedIdentity(user);

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe('user-1');
			});
		});
	});

	describe('createLogoutRedirectUrl', () => {
		const logoutRequest = (cookies: Record<string, string>) => mock<AuthlessRequest>({ cookies });

		it('returns null when there is no ID-token cookie', async () => {
			expect(await service.createLogoutRedirectUrl(logoutRequest({}))).toBeNull();
		});

		it('returns null when RP-initiated logout is disabled', async () => {
			const redirectUrl = await service.createLogoutRedirectUrl(
				logoutRequest({ 'n8n-oidc-id-token': 'encrypted-id-token' }),
			);

			expect(redirectUrl).toBeNull();
			expect(client.buildEndSessionUrl).not.toHaveBeenCalled();
		});

		it('builds the end-session URL with the decrypted ID token as hint', async () => {
			settingsRepository.findByKey.mockResolvedValue(
				storedRow({ ...validStoredConfig, rpInitiatedLogoutEnabled: true }),
			);
			cipher.decryptV2.mockResolvedValue('decrypted-id-token');
			vi.mocked(client.buildEndSessionUrl).mockReturnValue(
				new URL('https://idp.example.com/logout?id_token_hint=decrypted-id-token'),
			);

			const redirectUrl = await service.createLogoutRedirectUrl(
				logoutRequest({ 'n8n-oidc-id-token': 'encrypted-id-token' }),
			);

			expect(redirectUrl).toBe('https://idp.example.com/logout?id_token_hint=decrypted-id-token');
			const parameters = vi.mocked(client.buildEndSessionUrl).mock.calls[0][1];
			expect(parameters).toBeInstanceOf(URLSearchParams);
			if (parameters instanceof URLSearchParams) {
				expect(parameters.get('id_token_hint')).toBe('decrypted-id-token');
				expect(parameters.get('post_logout_redirect_uri')).toBe('http://localhost:5678');
			}
		});

		it('degrades to a local logout when the provider is unreachable', async () => {
			settingsRepository.findByKey.mockResolvedValue(
				storedRow({ ...validStoredConfig, rpInitiatedLogoutEnabled: true }),
			);
			vi.mocked(client.discovery).mockRejectedValue(new Error('provider down'));

			const redirectUrl = await service.createLogoutRedirectUrl(
				logoutRequest({ 'n8n-oidc-id-token': 'encrypted-id-token' }),
			);

			expect(redirectUrl).toBeNull();
		});
	});
});
