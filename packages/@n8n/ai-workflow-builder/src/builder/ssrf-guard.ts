import type { Result } from '@n8n/utils/result';
import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';

/**
 * Result of an SSRF check — the same shape as `@n8n/backend-network`'s
 * `SsrfCheckResult`, so the real `SsrfProtectionService` satisfies the guard.
 */
type SsrfCheckResult = Result<void, Error>;

/**
 * The subset of SSRF-protection behaviour the `web_fetch` tool needs. The real
 * `SsrfProtectionService` (which implements the wider `SsrfBridge`) satisfies
 * this, and so does {@link createPassthroughSsrfGuard} — letting the builder
 * take either, depending on whether SSRF protection is enabled.
 */
export interface WebFetchSsrfGuard {
	validateUrl(url: string | URL): Promise<SsrfCheckResult>;
	validateRedirectSync(url: string): void;
	createSecureLookup(): LookupFunction;
}

/**
 * A no-op guard used when SSRF protection is disabled by configuration: every
 * URL is allowed and DNS resolution falls back to the platform default. Only
 * ever selected when the operator has explicitly turned SSRF protection off.
 */
export function createPassthroughSsrfGuard(): WebFetchSsrfGuard {
	return {
		validateUrl: async (): Promise<SsrfCheckResult> => {
			await Promise.resolve();
			return { ok: true, result: undefined };
		},
		validateRedirectSync: () => {},
		createSecureLookup: (): LookupFunction => (hostname, options, onResolved) =>
			lookup(hostname, options, onResolved),
	};
}
