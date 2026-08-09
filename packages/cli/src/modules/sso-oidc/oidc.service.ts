import type { OidcConfigDto } from '@n8n/api-types';
import { OIDC_PROMPT_VALUES } from '@n8n/api-types';
import { Logger } from '@n8n/backend-common';
import { OutboundHttp } from '@n8n/backend-network';
import { GlobalConfig } from '@n8n/config';
import type { User } from '@n8n/db';
import {
	AuthIdentity,
	AuthIdentityRepository,
	GLOBAL_ADMIN_ROLE,
	GLOBAL_OWNER_ROLE,
	SettingsRepository,
	UserRepository,
} from '@n8n/db';
import { Service } from '@n8n/di';
import { isEmail } from 'class-validator';
import type { CookieOptions, Response } from 'express';
import { Cipher } from 'n8n-core';
import { randomString } from 'n8n-workflow';
import { createHash } from 'node:crypto';
import type * as oidcClient from 'openid-client';
import { z } from 'zod';

import { AuthService } from '@/auth/auth.service';
import { AuthError } from '@/errors/response-errors/auth.error';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ForbiddenError } from '@/errors/response-errors/forbidden.error';
import { ProvisioningService } from '@/modules/provisioning/provisioning.service';
import type { ProvisioningDecision } from '@/modules/provisioning/types';
import type { AuthlessRequest } from '@/requests';
import { PasswordUtility } from '@/services/password.utility';
import { UrlService } from '@/services/url.service';
import {
	assertAuthenticationMethodCanBeEnabled,
	getCurrentAuthenticationMethod,
	setCurrentAuthenticationMethod,
} from '@/sso/sso-helpers';

import {
	OIDC_CLIENT_SECRET_REDACTED_VALUE,
	OIDC_FLOW_COOKIE_MAX_AGE_MS,
	OIDC_ID_TOKEN_COOKIE_MAX_BYTES,
	OIDC_ID_TOKEN_COOKIE_NAME,
	OIDC_NONCE_COOKIE_NAME,
	OIDC_PKCE_COOKIE_NAME,
	OIDC_PREFERENCES_DB_KEY,
	OIDC_STATE_COOKIE_NAME,
} from './constants';
import { renderOidcTestFailure, renderOidcTestSuccess } from './views/oidc-test-result';

export type OidcPrompt = (typeof OIDC_PROMPT_VALUES)[number];

export type OidcRuntimeConfig = {
	clientId: string;
	clientSecret: string;
	discoveryEndpoint: URL;
	loginEnabled: boolean;
	prompt: OidcPrompt;
	authenticationContextClassReference: string[];
	additionalScopes: string;
	emailVerifiedRequired?: boolean;
	rpInitiatedLogoutEnabled: boolean;
};

/**
 * Shown in the discovery-endpoint field before any provider is configured.
 * The stored config carries the endpoint as a plain string, but consumers
 * receive a `URL`, so the unset case needs a syntactically valid value.
 */
const PLACEHOLDER_DISCOVERY_ENDPOINT = 'https://example.com/.well-known/openid-configuration';

/**
 * Shape of the settings row under `features.oidc`. The client secret is stored
 * encrypted (`Cipher.encryptV2`). The env loader writes the same shape minus
 * `emailVerifiedRequired`, so every field the loader omits needs a default.
 */
const storedConfigSchema = z.object({
	clientId: z.string().default(''),
	clientSecret: z.string().default(''),
	discoveryEndpoint: z.string().default(''),
	loginEnabled: z.boolean().default(false),
	prompt: z.enum(OIDC_PROMPT_VALUES).default('select_account'),
	authenticationContextClassReference: z.array(z.string()).default([]),
	additionalScopes: z.string().default(''),
	emailVerifiedRequired: z.boolean().default(false),
	rpInitiatedLogoutEnabled: z.boolean().default(false),
});

type StoredOidcConfig = z.infer<typeof storedConfigSchema>;

/**
 * Global roles that administer the instance. An external identity is never
 * attached to an account holding one of these by matching its email alone.
 */
const PRIVILEGED_GLOBAL_ROLE_SLUGS: ReadonlySet<string> = new Set([
	GLOBAL_OWNER_ROLE.slug,
	GLOBAL_ADMIN_ROLE.slug,
]);

/**
 * Single message for every login refusal that depends on which account the
 * provider named, so the response carries nothing about that account. The
 * reason is recorded in the log instead.
 */
const GENERIC_LOGIN_FAILURE = 'OIDC login failed';

/** Version tag of the `AuthIdentity.providerId` encoding produced below. */
const OIDC_PROVIDER_ID_PREFIX = 'oidc:v1:';

/**
 * Identity attributes taken from a single claims document, together with the
 * document they came from.
 */
type ResolvedOidcIdentity = {
	sub: string;
	issuer: string;
	email: string;
	emailVerified: boolean;
	firstName?: string;
	lastName?: string;
	claimSource: 'userinfo' | 'id_token';
};

@Service()
export class OidcService {
	/**
	 * Discovery result reused across logins. Keyed by the stored row's identity
	 * fields (with the secret in its encrypted form) so any config write busts it.
	 */
	private cachedConfiguration?: { key: string; configuration: oidcClient.Configuration };

	/**
	 * States of in-flight connection tests, mapped to their expiry epoch-ms.
	 * Consumed exactly once; a state absent here is a normal login callback.
	 */
	private readonly pendingTestStates = new Map<string, number>();

	constructor(
		private readonly logger: Logger,
		private readonly globalConfig: GlobalConfig,
		private readonly settingsRepository: SettingsRepository,
		private readonly authIdentityRepository: AuthIdentityRepository,
		private readonly userRepository: UserRepository,
		private readonly cipher: Cipher,
		private readonly outboundHttp: OutboundHttp,
		private readonly urlService: UrlService,
		private readonly authService: AuthService,
		private readonly passwordUtility: PasswordUtility,
		private readonly provisioningService: ProvisioningService,
	) {}

	async init(): Promise<void> {
		const stored = await this.loadStoredConfig();
		this.globalConfig.sso.oidc.loginEnabled = stored.loginEnabled;
		this.cachedConfiguration = undefined;
	}

	async loadConfig(includeSecret = false): Promise<OidcRuntimeConfig> {
		const stored = await this.loadStoredConfig();
		return await this.toRuntimeConfig(stored, includeSecret);
	}

	/** The current configuration in the shape the internal REST API returns. */
	async loadConfigForResponse(): Promise<OidcConfigDto> {
		const config = await this.loadConfig();
		return {
			...config,
			discoveryEndpoint: config.discoveryEndpoint.toString(),
			emailVerifiedRequired: config.emailVerifiedRequired ?? false,
		};
	}

	async updateConfig(newConfig: OidcConfigDto): Promise<OidcRuntimeConfig> {
		const clientId = newConfig.clientId.trim();
		if (!clientId) throw new BadRequestError('Client ID must not be empty');

		let clientSecret = newConfig.clientSecret;
		if (clientSecret === OIDC_CLIENT_SECRET_REDACTED_VALUE) {
			const stored = await this.loadStoredConfig();
			if (!stored.clientSecret) {
				throw new BadRequestError('There is no client secret stored for this configuration');
			}
			clientSecret = await this.cipher.decryptV2(stored.clientSecret);
		}
		if (!clientSecret) throw new BadRequestError('Client secret must not be empty');

		let discoveryEndpoint: URL;
		try {
			discoveryEndpoint = new URL(newConfig.discoveryEndpoint);
		} catch {
			throw new BadRequestError('Provided discovery endpoint is not a valid URL');
		}

		// Only one of SAML/OIDC/LDAP may be active; reject before any write.
		if (newConfig.loginEnabled) {
			try {
				assertAuthenticationMethodCanBeEnabled('oidc');
			} catch (error) {
				throw new BadRequestError(error instanceof Error ? error.message : String(error));
			}
		}

		// Validate the provider by executing discovery before accepting the write.
		try {
			await this.discover(discoveryEndpoint, clientId, clientSecret);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			throw new BadRequestError(`Could not validate the OIDC provider via discovery: ${reason}`);
		}

		const toStore: StoredOidcConfig = {
			clientId,
			clientSecret: await this.cipher.encryptV2(clientSecret),
			discoveryEndpoint: discoveryEndpoint.toString(),
			loginEnabled: newConfig.loginEnabled ?? false,
			prompt: newConfig.prompt ?? 'select_account',
			authenticationContextClassReference: newConfig.authenticationContextClassReference ?? [],
			additionalScopes: newConfig.additionalScopes ?? '',
			emailVerifiedRequired: newConfig.emailVerifiedRequired ?? false,
			rpInitiatedLogoutEnabled: newConfig.rpInitiatedLogoutEnabled ?? false,
		};
		await this.settingsRepository.upsertByKey(
			OIDC_PREFERENCES_DB_KEY,
			JSON.stringify(toStore),
			true,
			{},
		);
		this.cachedConfiguration = undefined;

		await this.setOidcLoginEnabled(toStore.loginEnabled);

		return await this.toRuntimeConfig(toStore, false);
	}

	isOidcLoginActive(): boolean {
		return this.globalConfig.sso.oidc.loginEnabled && getCurrentAuthenticationMethod() === 'oidc';
	}

	/**
	 * Builds the provider authorization URL and stores the per-request
	 * state/nonce/PKCE-verifier in short-lived cookies for the callback.
	 */
	async createAuthorizationUrl(
		res: Response,
		{ connectionTest = false }: { connectionTest?: boolean } = {},
	): Promise<string> {
		const config = await this.loadConfig(true);
		if (!config.clientId || !config.clientSecret) {
			throw new BadRequestError('OIDC is not configured');
		}

		const client = await this.oidc();
		const configuration = await this.getConfiguration();

		const state = client.randomState();
		const nonce = client.randomNonce();
		const codeVerifier = client.randomPKCECodeVerifier();
		const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

		const parameters = new URLSearchParams();
		parameters.set('redirect_uri', this.getCallbackUrl());
		parameters.set('scope', await this.buildScopes(config.additionalScopes));
		parameters.set('prompt', config.prompt);
		parameters.set('state', state);
		parameters.set('nonce', nonce);
		parameters.set('code_challenge', codeChallenge);
		parameters.set('code_challenge_method', 'S256');
		if (config.authenticationContextClassReference.length > 0) {
			parameters.set('acr_values', config.authenticationContextClassReference.join(' '));
		}

		const url = client.buildAuthorizationUrl(configuration, parameters);

		this.setFlowCookies(res, { state, nonce, codeVerifier });
		if (connectionTest) this.rememberPendingTestState(state);

		return url.toString();
	}

	/**
	 * Whether this callback belongs to an in-flight connection test.
	 * Consumes the pending test marker, so it returns `true` exactly once.
	 */
	consumePendingTestCallback(req: AuthlessRequest): boolean {
		const { state } = this.readFlowCookies(req);
		if (!state) return false;
		const expiresAt = this.pendingTestStates.get(state);
		if (expiresAt === undefined) return false;
		this.pendingTestStates.delete(state);
		return expiresAt > Date.now();
	}

	/** Handles a connection-test callback. Always resolves to a result page. */
	async runConnectionTestCallback(req: AuthlessRequest, res: Response): Promise<string> {
		try {
			const { claims, userInfo } = await this.exchangeCodeForTokens(req, res);
			return renderOidcTestSuccess({ claims: { ...claims }, userInfo: { ...userInfo } });
		} catch (error) {
			return renderOidcTestFailure(error);
		}
	}

	/**
	 * Handles a normal login callback: exchanges the code, maps the claims and
	 * resolves (or provisions) the n8n user. Session issuance stays with the
	 * controller so this method has no auth-cookie side effects.
	 */
	async runLoginCallback(
		req: AuthlessRequest,
		res: Response,
	): Promise<{ user: User; idToken?: string }> {
		if (!this.isOidcLoginActive()) {
			throw new AuthError('OIDC login is not enabled');
		}
		const { claims, userInfo, idToken } = await this.exchangeCodeForTokens(req, res);
		const user = await this.resolveSignInUser(claims, userInfo);
		return { user, idToken };
	}

	/**
	 * Stores the encrypted ID token so a later sign-out can pass it as
	 * `id_token_hint`. Oversized tokens skip the cookie; sign-out then degrades
	 * to a local-only logout.
	 */
	async setIdTokenCookie(res: Response, idToken: string | undefined): Promise<void> {
		if (!idToken) return;
		const encrypted = await this.cipher.encryptV2(idToken);
		if (Buffer.byteLength(encrypted, 'utf8') > OIDC_ID_TOKEN_COOKIE_MAX_BYTES) {
			this.logger.debug('OIDC ID token exceeds the cookie size limit, skipping the cookie');
			return;
		}
		res.cookie(OIDC_ID_TOKEN_COOKIE_NAME, encrypted, {
			...this.oidcCookieOptions(),
			maxAge: this.authService.jwtExpiration * 1000,
		});
	}

	clearIdTokenCookie(res: Response): void {
		res.clearCookie(OIDC_ID_TOKEN_COOKIE_NAME, this.oidcCookieOptions());
	}

	/**
	 * Builds the provider's RP-Initiated Logout URL for the current session, or
	 * `null` when no provider redirect is possible. Never throws: the local
	 * logout must proceed regardless of provider availability.
	 */
	async createLogoutRedirectUrl(req: AuthlessRequest): Promise<string | null> {
		const encryptedIdToken: unknown = req.cookies[OIDC_ID_TOKEN_COOKIE_NAME];
		if (typeof encryptedIdToken !== 'string' || !encryptedIdToken) return null;

		try {
			const config = await this.loadConfig(true);
			if (!config.rpInitiatedLogoutEnabled) return null;

			const client = await this.oidc();
			const configuration = await this.getConfiguration();
			if (!configuration.serverMetadata().end_session_endpoint) return null;

			const idToken = await this.cipher.decryptV2(encryptedIdToken);
			const parameters = new URLSearchParams();
			parameters.set('post_logout_redirect_uri', this.urlService.getInstanceBaseUrl());
			parameters.set('id_token_hint', idToken);
			return client.buildEndSessionUrl(configuration, parameters).toString();
		} catch (error) {
			this.logger.warn('Could not build the OIDC RP-initiated logout URL', {
				error: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
	}

	// ----------------------------------
	//        configuration internals
	// ----------------------------------

	private async loadStoredConfig(): Promise<StoredOidcConfig> {
		const row = await this.settingsRepository.findByKey(OIDC_PREFERENCES_DB_KEY);
		if (!row) return storedConfigSchema.parse({});
		try {
			return storedConfigSchema.parse(JSON.parse(row.value));
		} catch (error) {
			this.logger.warn('Stored OIDC configuration could not be parsed, using defaults', {
				error: error instanceof Error ? error.message : String(error),
			});
			return storedConfigSchema.parse({});
		}
	}

	private async toRuntimeConfig(
		stored: StoredOidcConfig,
		includeSecret: boolean,
	): Promise<OidcRuntimeConfig> {
		const { clientSecret: storedSecret, discoveryEndpoint, ...rest } = stored;
		const clientSecret = storedSecret
			? includeSecret
				? await this.cipher.decryptV2(storedSecret)
				: OIDC_CLIENT_SECRET_REDACTED_VALUE
			: '';
		return {
			...rest,
			clientSecret,
			discoveryEndpoint: new URL(discoveryEndpoint || PLACEHOLDER_DISCOVERY_ENDPOINT),
		};
	}

	private async setOidcLoginEnabled(enabled: boolean): Promise<void> {
		const currentAuthenticationMethod = getCurrentAuthenticationMethod();
		if (enabled) assertAuthenticationMethodCanBeEnabled('oidc');

		const targetAuthenticationMethod =
			!enabled && currentAuthenticationMethod === 'oidc' ? 'email' : currentAuthenticationMethod;

		this.globalConfig.sso.oidc.loginEnabled = enabled;
		await setCurrentAuthenticationMethod(enabled ? 'oidc' : targetAuthenticationMethod);
	}

	private async oidc(): Promise<typeof oidcClient> {
		// Lazy-loaded: only SSO code paths need it, not every request.
		return await import('openid-client');
	}

	private async getConfiguration(): Promise<oidcClient.Configuration> {
		const stored = await this.loadStoredConfig();
		// The secret participates in encrypted form, so a secret rotation still busts the cache.
		const key = [stored.discoveryEndpoint, stored.clientId, stored.clientSecret].join(' ');
		if (this.cachedConfiguration?.key === key) return this.cachedConfiguration.configuration;

		const config = await this.toRuntimeConfig(stored, true);
		const configuration = await this.discover(
			config.discoveryEndpoint,
			config.clientId,
			config.clientSecret,
		);
		this.cachedConfiguration = { key, configuration };
		return configuration;
	}

	private async discover(
		discoveryEndpoint: URL,
		clientId: string,
		clientSecret: string,
	): Promise<oidcClient.Configuration> {
		const client = await this.oidc();
		const customFetch = this.buildCustomFetch();
		const configuration = await client.discovery(
			discoveryEndpoint,
			clientId,
			clientSecret,
			undefined,
			{ [client.customFetch]: customFetch },
		);
		// Carry the same fetch into token-exchange and UserInfo requests.
		configuration[client.customFetch] = customFetch;
		return configuration;
	}

	private buildCustomFetch(): oidcClient.CustomFetch {
		// Route provider traffic through the outbound-HTTP factory (proxy + SSRF policy).
		const transportFetch = this.outboundHttp.transport().asCustomFetch();
		return async (url, options) =>
			await transportFetch(url, {
				method: options.method,
				headers: options.headers,
				// `.slice()` re-types a Uint8Array body onto a plain ArrayBuffer,
				// which `BodyInit` requires; the payloads are small form bodies.
				body: options.body instanceof Uint8Array ? options.body.slice() : options.body,
				redirect: options.redirect,
				signal: options.signal,
			});
	}

	// ----------------------------------
	//        authorization internals
	// ----------------------------------

	private getCallbackUrl(): string {
		const restEndpoint = this.globalConfig.endpoints.rest;
		return `${this.urlService.getInstanceBaseUrl()}/${restEndpoint}/sso/oidc/callback`;
	}

	/**
	 * Scope generation reads the same persisted policy the login-time evaluation
	 * reads. Sourcing it from `GlobalConfig` instead would let the config
	 * endpoint enable a role claim without ever requesting its scope, so the
	 * claim would never arrive.
	 */
	private async buildScopes(additionalScopes: string): Promise<string> {
		const scopes = new Set(['openid', 'profile', 'email']);
		const provisioning = await this.provisioningService.getProvisioningConfig();
		if (provisioning.scopesProvisionInstanceRole || provisioning.scopesProvisionProjectRoles) {
			scopes.add(provisioning.scopesName);
		}
		for (const scope of additionalScopes.split(/\s+/)) {
			if (scope) scopes.add(scope);
		}
		return [...scopes].join(' ');
	}

	private oidcCookieOptions(): CookieOptions {
		const { secure } = this.globalConfig.auth.cookie;
		return {
			httpOnly: true,
			secure,
			// The provider redirects back with a cross-site top-level navigation;
			// 'strict' would drop the cookies on that request.
			sameSite: 'lax',
			path: `/${this.globalConfig.endpoints.rest}/sso/oidc`,
		};
	}

	private setFlowCookies(
		res: Response,
		{ state, nonce, codeVerifier }: { state: string; nonce: string; codeVerifier: string },
	): void {
		const options = { ...this.oidcCookieOptions(), maxAge: OIDC_FLOW_COOKIE_MAX_AGE_MS };
		res.cookie(OIDC_STATE_COOKIE_NAME, state, options);
		res.cookie(OIDC_NONCE_COOKIE_NAME, nonce, options);
		res.cookie(OIDC_PKCE_COOKIE_NAME, codeVerifier, options);
	}

	private clearFlowCookies(res: Response): void {
		const options = this.oidcCookieOptions();
		res.clearCookie(OIDC_STATE_COOKIE_NAME, options);
		res.clearCookie(OIDC_NONCE_COOKIE_NAME, options);
		res.clearCookie(OIDC_PKCE_COOKIE_NAME, options);
	}

	private readFlowCookies(req: AuthlessRequest): {
		state?: string;
		nonce?: string;
		codeVerifier?: string;
	} {
		const readCookie = (name: string): string | undefined => {
			const value: unknown = req.cookies[name];
			return typeof value === 'string' && value ? value : undefined;
		};
		return {
			state: readCookie(OIDC_STATE_COOKIE_NAME),
			nonce: readCookie(OIDC_NONCE_COOKIE_NAME),
			codeVerifier: readCookie(OIDC_PKCE_COOKIE_NAME),
		};
	}

	private rememberPendingTestState(state: string): void {
		const now = Date.now();
		for (const [pendingState, expiresAt] of this.pendingTestStates) {
			if (expiresAt <= now) this.pendingTestStates.delete(pendingState);
		}
		this.pendingTestStates.set(state, now + OIDC_FLOW_COOKIE_MAX_AGE_MS);
	}

	// ----------------------------------
	//          callback internals
	// ----------------------------------

	private async exchangeCodeForTokens(
		req: AuthlessRequest,
		res: Response,
	): Promise<{
		claims: oidcClient.IDToken;
		userInfo: oidcClient.UserInfoResponse;
		idToken?: string;
	}> {
		const { state, nonce, codeVerifier } = this.readFlowCookies(req);
		// The flow artifacts are single-use: clear them before any validation.
		this.clearFlowCookies(res);
		if (!state || !nonce || !codeVerifier) {
			throw new AuthError('Invalid OIDC callback: the login flow cookies are missing or expired');
		}

		const client = await this.oidc();
		const configuration = await this.getConfiguration();
		const currentUrl = new URL(req.originalUrl, this.urlService.getInstanceBaseUrl());

		const tokens = await client.authorizationCodeGrant(configuration, currentUrl, {
			expectedState: state,
			expectedNonce: nonce,
			pkceCodeVerifier: codeVerifier,
			idTokenExpected: true,
		});

		const claims = tokens.claims();
		if (!claims?.sub) {
			throw new AuthError('Invalid OIDC callback: the ID token has no subject');
		}

		const userInfo = await client.fetchUserInfo(configuration, tokens.access_token, claims.sub);

		return { claims, userInfo, idToken: tokens.id_token };
	}

	// ----------------------------------
	//        provisioning internals
	// ----------------------------------

	/**
	 * Reads the identity attributes that decide which account a login resolves
	 * to. `email` and `email_verified` always come from the same claims
	 * document: UserInfo when it carries an email, the ID token otherwise. A
	 * verification flag is never combined with an email from the other
	 * document, and the two documents must agree wherever both speak.
	 */
	private resolveIdentityClaims(
		claims: oidcClient.IDToken,
		userInfo: oidcClient.UserInfoResponse,
	): ResolvedOidcIdentity {
		const issuer = this.pickString(claims.iss);
		if (!issuer) {
			throw new AuthError('Invalid OIDC callback: the ID token has no issuer');
		}

		// `client.fetchUserInfo` is called with the ID token's subject as its
		// expected subject and rejects a mismatch, so this repeats the library's
		// own guarantee rather than replacing it.
		const userInfoSub = this.pickString(userInfo.sub);
		if (userInfoSub && userInfoSub !== claims.sub) {
			throw new AuthError('OIDC login failed: the provider returned conflicting subjects');
		}

		const userInfoEmail = this.pickString(userInfo.email);
		const idTokenEmail = this.pickString(claims.email);
		if (
			userInfoEmail &&
			idTokenEmail &&
			userInfoEmail.toLowerCase() !== idTokenEmail.toLowerCase()
		) {
			throw new AuthError('OIDC login failed: the provider returned conflicting email addresses');
		}

		const claimSource = userInfoEmail ? 'userinfo' : 'id_token';
		const email = userInfoEmail ?? idTokenEmail;
		if (!email) {
			throw new AuthError('OIDC login failed: the provider did not return an email address');
		}
		if (!isEmail(email)) {
			throw new BadRequestError('Invalid email format');
		}

		const verifiedFlag =
			claimSource === 'userinfo' ? userInfo.email_verified : claims.email_verified;

		return {
			sub: claims.sub,
			issuer,
			email,
			emailVerified: verifiedFlag === true,
			// Display names are not identity-deciding, so the usual preference applies.
			firstName: this.pickString(userInfo.given_name) ?? this.pickString(claims.given_name),
			lastName: this.pickString(userInfo.family_name) ?? this.pickString(claims.family_name),
			claimSource,
		};
	}

	/**
	 * Stable `AuthIdentity.providerId` for an OIDC subject. Subjects are unique
	 * only within their issuer, so both values are folded into one digest: the
	 * column holds a single string, and a digest keeps the value inside its
	 * 255-character limit and free of delimiter ambiguity for any issuer or
	 * subject length. The subject itself stays readable in provider logs.
	 */
	private oidcProviderId(issuer: string, sub: string): string {
		// The issuer digest is fixed-length, so concatenating it with the
		// subject is unambiguous without a separator character.
		const issuerDigest = createHash('sha256').update(issuer).digest('hex');
		const digest = createHash('sha256')
			.update(issuerDigest + sub)
			.digest('base64url');
		return `${OIDC_PROVIDER_ID_PREFIX}${digest}`;
	}

	/**
	 * Evaluates the role-provisioning policy for this login. Runs before any
	 * account lookup, so a denial — or a policy that cannot be evaluated —
	 * cannot be preceded by a mutation.
	 */
	private async decideProvisioning(
		claims: oidcClient.IDToken,
		userInfo: oidcClient.UserInfoResponse,
	): Promise<ProvisioningDecision> {
		const idToken: Record<string, unknown> = { ...claims };
		const userInfoClaims: Record<string, unknown> = { ...userInfo };

		const decision = await this.provisioningService.resolveLoginProvisioning({
			provider: 'oidc',
			// UserInfo overlays the ID token: it is the fuller profile document and
			// is already the preferred source for identity claims in this service.
			claims: { ...idToken, ...userInfoClaims },
			providerContext: { provider: 'oidc', idToken, userInfo: userInfoClaims },
			directClaims: await this.extractConfiguredRoleClaims(idToken, userInfoClaims),
		});

		if (decision.outcome === 'deny') {
			this.logger.warn('OIDC login denied by the role provisioning policy', {
				reason: decision.reason,
			});
			throw new AuthError(GENERIC_LOGIN_FAILURE);
		}
		return decision;
	}

	/** Direct role claims, read under the names the persisted policy configures. */
	private async extractConfiguredRoleClaims(
		idToken: Record<string, unknown>,
		userInfo: Record<string, unknown>,
	): Promise<{ instanceRole?: string; projectRoles?: string[] }> {
		const config = await this.provisioningService.getProvisioningConfig();
		const read = (name: string): unknown => userInfo[name] ?? idToken[name];

		const instanceRoleClaim = config.scopesProvisionInstanceRole
			? read(config.scopesInstanceRoleClaimName)
			: undefined;
		const projectRolesClaim = config.scopesProvisionProjectRoles
			? read(config.scopesProjectsRolesClaimName)
			: undefined;

		return {
			instanceRole: typeof instanceRoleClaim === 'string' ? instanceRoleClaim : undefined,
			projectRoles: toStringArray(projectRolesClaim),
		};
	}

	/**
	 * Maps the provider identity to an n8n user: by issuer-scoped OIDC identity
	 * first, then by a legacy subject-only identity, then by email, then
	 * just-in-time creation.
	 */
	private async resolveSignInUser(
		claims: oidcClient.IDToken,
		userInfo: oidcClient.UserInfoResponse,
	): Promise<User> {
		const decision = await this.decideProvisioning(claims, userInfo);
		const user = await this.resolveAccount(claims, userInfo);

		const result = await this.provisioningService.applyLoginProvisioning(user, decision);
		if (!result.instanceRoleChanged) return user;

		const reloaded = await this.userRepository.findOne({
			where: { id: user.id },
			relations: ['role'],
		});
		return reloaded ?? user;
	}

	private async resolveAccount(
		claims: oidcClient.IDToken,
		userInfo: oidcClient.UserInfoResponse,
	): Promise<User> {
		const config = await this.loadConfig();
		const identity = this.resolveIdentityClaims(claims, userInfo);

		if (config.emailVerifiedRequired && !identity.emailVerified) {
			throw new ForbiddenError(
				'OIDC login rejected: the provider did not report the email address as verified',
			);
		}

		const providerId = this.oidcProviderId(identity.issuer, identity.sub);
		const known = await this.authIdentityRepository.findOne({
			where: { providerId, providerType: 'oidc' },
			relations: { user: { role: true } },
		});
		if (known?.user) {
			return await this.updateUserNames(known.user, identity);
		}

		const adopted = await this.adoptLegacyIdentity(providerId, identity);
		if (adopted) return await this.updateUserNames(adopted, identity);

		const existingUser = await this.userRepository.findOne({
			where: { email: identity.email.toLowerCase() },
			relations: ['role', 'authIdentities'],
		});
		if (existingUser) {
			this.assertAccountMayBeLinked(existingUser, identity);
			await this.authIdentityRepository.save(
				this.authIdentityRepository.create({
					providerId,
					providerType: 'oidc',
					userId: existingUser.id,
				}),
				{ transaction: false },
			);
			return await this.updateUserNames(existingUser, identity);
		}

		if (!this.globalConfig.sso.justInTimeProvisioning) {
			throw new AuthError(
				'OIDC login failed: no account exists for this identity and just-in-time provisioning is disabled',
			);
		}
		return await this.createUser(providerId, identity);
	}

	/**
	 * Identities provisioned before subjects were issuer-scoped are stored under
	 * the bare subject. Such a row is re-keyed to the issuer-scoped value on the
	 * next login that also presents the account's stored email — the pair the
	 * row was created from. A row whose email no longer matches is left
	 * untouched and resolution continues along the email path, so a subject
	 * collision at a different issuer cannot inherit it.
	 *
	 * A subject-only row records no issuer, so the stored email is the only
	 * thing tying it to this provider. It therefore carries the same conditions
	 * as an email match: the address must be reported as verified, and an
	 * account with a privileged global role is not resolved this way.
	 */
	private async adoptLegacyIdentity(
		providerId: string,
		identity: ResolvedOidcIdentity,
	): Promise<User | undefined> {
		const legacy = await this.authIdentityRepository.findOne({
			where: { providerId: identity.sub, providerType: 'oidc' },
			relations: { user: { role: true } },
		});
		if (!legacy?.user) return undefined;

		if (legacy.user.email?.toLowerCase() !== identity.email.toLowerCase()) {
			this.logger.warn(
				'OIDC login did not re-key a subject-only identity: the stored account email differs',
				{ userId: legacy.user.id },
			);
			return undefined;
		}

		if (!identity.emailVerified) {
			this.logger.warn(
				'OIDC login refused: a subject-only identity needs a verified email address to be re-keyed',
				{ userId: legacy.user.id, claimSource: identity.claimSource },
			);
			throw new AuthError(GENERIC_LOGIN_FAILURE);
		}

		if (PRIVILEGED_GLOBAL_ROLE_SLUGS.has(legacy.user.role?.slug)) {
			this.logger.warn(
				'OIDC login refused: a subject-only identity cannot be re-keyed onto an account with a privileged global role',
				{ userId: legacy.user.id, role: legacy.user.role.slug },
			);
			throw new AuthError(GENERIC_LOGIN_FAILURE);
		}

		await this.authIdentityRepository.update(
			{ providerId: identity.sub, providerType: 'oidc' },
			{ providerId },
		);
		return legacy.user;
	}

	/**
	 * Guards the email-matching path. An address is only trusted to name an
	 * existing account when the provider reports it as verified, independently
	 * of `emailVerifiedRequired`, and an account that administers the instance
	 * is never given a first external identity this way.
	 */
	private assertAccountMayBeLinked(existingUser: User, identity: ResolvedOidcIdentity): void {
		// Verification is checked first, so an unverified address targeting a
		// privileged account is logged under the unverified reason.
		if (!identity.emailVerified) {
			this.logger.warn(
				'OIDC login refused: an unverified email address cannot resolve to an existing account',
				{ userId: existingUser.id, claimSource: identity.claimSource },
			);
			throw new AuthError(GENERIC_LOGIN_FAILURE);
		}

		const hasOidcIdentity =
			existingUser.authIdentities?.some((row) => row.providerType === 'oidc') ?? false;
		if (!hasOidcIdentity && PRIVILEGED_GLOBAL_ROLE_SLUGS.has(existingUser.role?.slug)) {
			this.logger.warn(
				'OIDC login refused: an account with a privileged global role has no OIDC identity to match',
				{ userId: existingUser.id, role: existingUser.role.slug },
			);
			throw new AuthError(GENERIC_LOGIN_FAILURE);
		}
	}

	private async updateUserNames(
		user: User,
		{ firstName, lastName }: Pick<ResolvedOidcIdentity, 'firstName' | 'lastName'>,
	): Promise<User> {
		if ((!firstName || user.firstName === firstName) && (!lastName || user.lastName === lastName)) {
			return user;
		}
		if (firstName) user.firstName = firstName;
		if (lastName) user.lastName = lastName;
		// `save` (not `update`) so entity subscribers receive the full user.
		const savedUser = await this.userRepository.save(user, { transaction: false });
		if (!savedUser) throw new AuthError('Could not update User');
		const userWithRole = await this.userRepository.findOne({
			where: { id: savedUser.id },
			relations: ['role'],
		});
		if (!userWithRole) throw new AuthError('Failed to fetch user!');
		return userWithRole;
	}

	private async createUser(
		providerId: string,
		{ email, firstName, lastName }: ResolvedOidcIdentity,
	): Promise<User> {
		// A password that is not used or known to the user.
		const randomPassword = randomString(18);
		return await this.userRepository.manager.transaction(async (trx) => {
			const { user } = await this.userRepository.createUserWithProject(
				{
					email: email.toLowerCase(),
					firstName: firstName ?? '',
					lastName: lastName ?? '',
					role: { slug: 'global:member' },
					password: await this.passwordUtility.hash(randomPassword),
				},
				trx,
			);

			await trx.save(
				trx.create(AuthIdentity, {
					providerId,
					providerType: 'oidc',
					userId: user.id,
				}),
			);

			return user;
		});
	}

	private pickString(value: unknown): string | undefined {
		return typeof value === 'string' && value ? value : undefined;
	}
}

/** Normalize a role claim that may arrive as a single value or a list. */
function toStringArray(value: unknown): string[] | undefined {
	if (typeof value === 'string') return [value];
	if (!Array.isArray(value)) return undefined;
	const entries = value.filter((entry): entry is string => typeof entry === 'string');
	return entries.length > 0 ? entries : undefined;
}
