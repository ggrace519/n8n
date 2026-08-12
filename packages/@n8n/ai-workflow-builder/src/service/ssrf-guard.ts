import { createResultOk, type Result } from '@n8n/utils/result';
import { lookup } from 'node:dns';
import type { LookupFunction } from 'node:net';

/**
 * The slice of SSRF protection the builder's `web_fetch` tool needs.
 *
 * Narrower than `SsrfBridge` in `@n8n/backend-network` on purpose — only URL
 * validation, redirect checking, and DNS lookup are relevant here, and the full
 * service satisfies this structurally. Depending on the wider interface would
 * make every future method on it a breaking change for this package.
 */
export interface WebFetchSsrfGuard {
	validateUrl(url: string | URL): Promise<Result<void, Error>>;
	validateRedirectSync(url: string): void;
	createSecureLookup(): LookupFunction;
}

/**
 * A guard that allows everything, for when SSRF protection is switched off
 * instance-wide (`SsrfProtectionConfig.enabled === false`).
 *
 * This exists so the disabled path is an explicit, named object rather than an
 * `undefined` the call sites have to keep testing for. It is only ever selected
 * by that config flag — never as a fallback when constructing the real guard
 * fails, which would turn a misconfiguration into a silently unprotected
 * fetch of LLM-chosen URLs.
 */
export function createPassthroughSsrfGuard(): WebFetchSsrfGuard {
	return {
		// Async to match the real guard, which resolves DNS before answering.
		// eslint-disable-next-line @typescript-eslint/require-await
		async validateUrl() {
			return createResultOk(undefined);
		},
		validateRedirectSync() {},
		createSecureLookup() {
			return lookup;
		},
	};
}
