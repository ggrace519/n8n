import type { Logger } from '@n8n/backend-common';
import type { OutboundHttp } from '@n8n/backend-network';
import type { GlobalConfig } from '@n8n/config';
import type {
	AuthIdentityRepository,
	Settings,
	SettingsRepository,
	User,
	UserRepository,
} from '@n8n/db';
import type { Response } from 'express';
import type { Cipher } from 'n8n-core';
import * as client from 'openid-client';
import { mock } from 'vitest-mock-extended';

import type { AuthService } from '@/auth/auth.service';
import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
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
			urlService,
			authService,
			passwordUtility,
		);

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

		it('requests the provisioning scope when claim provisioning is enabled', async () => {
			globalConfig.sso.provisioning.scopesProvisionInstanceRole = true;

			const url = await service.createAuthorizationUrl(mock<Response>());

			expect(new URL(url).searchParams.get('scope')).toBe('openid profile email n8n');
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
			sub: 'subject-1',
			email: 'claims@example.com',
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

		const mockUserResolution = () => {
			const user = mock<User>({ id: 'user-1', firstName: 'User', lastName: 'Info' });
			authIdentityRepository.findOne.mockResolvedValue(
				mock<Awaited<ReturnType<AuthIdentityRepository['findOne']>>>({ user }),
			);
			return user;
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
			it('prefers the userinfo email over the ID-token claim', async () => {
				mockTokens();
				const user = mockUserResolution();

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe(user.id);
				expect(authIdentityRepository.findOne).toHaveBeenCalledWith({
					where: { providerId: 'subject-1', providerType: 'oidc' },
					relations: { user: { role: true } },
				});
			});

			it('falls back to the ID-token email when userinfo has none', async () => {
				mockTokens();
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
				mockTokens({ claims: { sub: 'subject-1' } });
				vi.mocked(client.fetchUserInfo).mockResolvedValue({
					sub: 'subject-1',
				} as unknown as client.UserInfoResponse);

				await expect(
					service.runLoginCallback(callbackRequest(), mock<Response>()),
				).rejects.toThrowError('did not return an email address');
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
				const user = mockUserResolution();

				const result = await service.runLoginCallback(callbackRequest(), mock<Response>());

				expect(result.user.id).toBe(user.id);
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
