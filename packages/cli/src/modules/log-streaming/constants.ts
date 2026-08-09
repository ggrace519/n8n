/** Placeholder returned instead of secret-bearing webhook option values by read APIs. */
export const REDACTED_SECRET_VALUE = '**********';

/**
 * Generic credential types a webhook destination can resolve into request
 * authentication. Anything else is rejected at validation time and aborts
 * delivery at send time.
 */
export const SUPPORTED_GENERIC_AUTH_TYPES = ['httpHeaderAuth', 'httpBasicAuth'] as const;

export type SupportedGenericAuthType = (typeof SUPPORTED_GENERIC_AUTH_TYPES)[number];

export function isSupportedGenericAuthType(value: string): value is SupportedGenericAuthType {
	return (SUPPORTED_GENERIC_AUTH_TYPES as readonly string[]).includes(value);
}

/** Per-destination cap on queued deliveries; see `BoundedDeliveryQueue`. */
export const MAX_QUEUED_DELIVERIES = 100;

/** How long `close()` waits for in-flight deliveries before closing the transport. */
export const CLOSE_DRAIN_TIMEOUT_MS = 10_000;
