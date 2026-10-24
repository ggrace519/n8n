import { Logger } from '@n8n/backend-common';
import { OutboundHttp, SsrfProtectionService, type HttpRequestClient } from '@n8n/backend-network';
import { SsrfProtectionConfig } from '@n8n/config';
import { Service } from '@n8n/di';

import { validateOAuthUrl } from '@/oauth/validate-oauth-url';

import { CredentialResolutionError } from '../../errors/credential-resolution.error';

/** Resolver type whose subjects are identified through an OIDC UserInfo endpoint. */
export const OAUTH2_RESOLVER_TYPE = 'credential-resolver.oauth2-1.0';

/** `config.validation` value selecting UserInfo-based identification. */
export const OAUTH2_USERINFO_VALIDATION = 'oauth2-userinfo';

/**
 * Credential-context source of an identity that came from an external caller
 * (a Bearer token for the resolver's provider). Only identities with this source
 * are ever sent to a non-n8n resolver — an n8n session or n8n-issued OAuth token
 * must never reach a third-party UserInfo endpoint.
 */
export const EXTERNAL_IDENTITY_SOURCE = 'external';

const REQUEST_TIMEOUT_MS = 10_000;
const DISCOVERY_TTL_MS = 10 * 60_000;

const NOT_IDENTIFIED = 'The external user could not be identified by the credential resolver';

type DiscoveryEntry = { userinfoEndpoint: string; expiresAt: number };

/**
 * Identifies an external user for a `credential-resolver.oauth2-1.0` resolver.
 *
 * The caller's Bearer access token is presented to the provider's UserInfo
 * endpoint (OIDC Core §5.3); the endpoint is read from the discovery document at
 * the resolver's `metadataUri` (OIDC Discovery). The subject is the returned
 * `sub` claim — stable for the user, unlike the access token itself.
 */
@Service()
export class OAuth2UserinfoIdentifier {
	private readonly discovery = new Map<string, DiscoveryEntry>();

	private readonly http: HttpRequestClient;

	constructor(
		private readonly logger: Logger,
		outboundHttp: OutboundHttp,
		ssrfProtectionService: SsrfProtectionService,
		ssrfProtectionConfig: SsrfProtectionConfig,
	) {
		// Both URLs reach the network on behalf of the caller (the UserInfo one is
		// provider-supplied), so they get the same SSRF policy as OAuth discovery.
		this.http = outboundHttp.requests({
			ssrf: ssrfProtectionConfig.enabled ? ssrfProtectionService : 'disabled',
			timeout: REQUEST_TIMEOUT_MS,
		});
	}

	/** Whether this identifier can verify subjects for a resolver of `type` with `config`. */
	static supports(type: string, config: Record<string, unknown>): boolean {
		return (
			type === OAUTH2_RESOLVER_TYPE &&
			config.validation === OAUTH2_USERINFO_VALIDATION &&
			typeof config.metadataUri === 'string'
		);
	}

	async resolve(identity: string, config: Record<string, unknown>): Promise<string> {
		const token = bearerToken(identity);
		if (!token || typeof config.metadataUri !== 'string') {
			throw new CredentialResolutionError(NOT_IDENTIFIED);
		}

		const userinfoEndpoint = await this.userinfoEndpoint(config.metadataUri);
		const body = await this.getJson(userinfoEndpoint, { Authorization: `Bearer ${token}` });
		const sub = isRecord(body) ? body.sub : undefined;
		if (typeof sub !== 'string' || sub.length === 0) {
			throw new CredentialResolutionError(NOT_IDENTIFIED);
		}
		return sub;
	}

	private async userinfoEndpoint(metadataUri: string): Promise<string> {
		const cached = this.discovery.get(metadataUri);
		if (cached && cached.expiresAt > Date.now()) return cached.userinfoEndpoint;

		const document = await this.getJson(metadataUri, {});
		const endpoint = isRecord(document) ? document.userinfo_endpoint : undefined;
		if (typeof endpoint !== 'string' || !sameOrigin(endpoint, metadataUri)) {
			// The caller's token goes to this URL: a provider may only point it at its
			// own origin, not at another host (or an internal one).
			this.logger.warn('OIDC discovery document has no usable userinfo_endpoint', {
				metadataUri,
			});
			throw new CredentialResolutionError(NOT_IDENTIFIED);
		}

		this.discovery.set(metadataUri, {
			userinfoEndpoint: endpoint,
			expiresAt: Date.now() + DISCOVERY_TTL_MS,
		});
		return endpoint;
	}

	/** GET a JSON document; any invalid URL, network error or non-2xx is "not identified". */
	private async getJson(url: string, headers: Record<string, string>): Promise<unknown> {
		try {
			validateOAuthUrl(url);
			if (new URL(url).protocol !== 'https:') throw new Error('Only https is allowed');
			return await this.http.request({
				url,
				method: 'GET',
				headers: { ...headers, Accept: 'application/json' },
				json: true,
				// Never follow a redirect: the request may carry the caller's token.
				maxRedirects: 0,
				sendCredentialsOnCrossOriginRedirect: false,
			});
		} catch (error) {
			// The request carried the caller's token: log the URL and reason only.
			this.logger.debug('OAuth2 provider did not identify the external user', {
				url,
				reason: error instanceof Error ? error.message : String(error),
			});
			throw new CredentialResolutionError(NOT_IDENTIFIED);
		}
	}
}

/**
 * The identity arrives as `Bearer <token>` from request headers, or as the bare
 * token once the OAuth callback has stripped the prefix.
 */
function bearerToken(identity: string): string | undefined {
	const trimmed = identity.trim();
	const match = /^Bearer\s+(\S+)$/i.exec(trimmed);
	if (match) return match[1];
	return trimmed.length > 0 && !/\s/.test(trimmed) ? trimmed : undefined;
}

function sameOrigin(a: string, b: string): boolean {
	try {
		return new URL(a).origin === new URL(b).origin;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}
