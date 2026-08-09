import { InvalidSamlMetadataError } from './errors/invalid-saml-metadata.error';

/** Loopback hosts that may be reached over plain HTTP during local development. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * IdP endpoints are taken from operator-supplied metadata and end up in
 * browser navigations, so only absolute `https:` URLs are accepted. Plain
 * `http:` is allowed for loopback hosts so local IdPs stay usable.
 */
export function isSupportedSamlEndpointUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value === '') return false;

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}

	if (parsed.protocol === 'https:') return true;
	if (parsed.protocol !== 'http:') return false;

	return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
}

/** Throw `InvalidSamlMetadataError` unless the endpoint passes {@link isSupportedSamlEndpointUrl}. */
export function assertSupportedSamlEndpointUrl(value: unknown, endpointLabel: string): void {
	if (isSupportedSamlEndpointUrl(value)) return;
	throw new InvalidSamlMetadataError(
		`the ${endpointLabel} endpoint must be an https URL (http is only allowed for localhost).`,
	);
}
