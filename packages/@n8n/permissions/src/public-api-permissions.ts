import { API_KEY_RESOURCES } from './constants';
import type { ApiKeyScope } from './types';

/** Every scope grantable to a public API key, flattened from the catalog. */
export const API_KEY_SCOPES: ApiKeyScope[] = Object.entries(API_KEY_RESOURCES).flatMap(
	([resource, operations]) => operations.map((op) => `${resource}:${op}` as ApiKeyScope),
);

/** Scopes available to an instance owner's API key (the full set). */
export const OWNER_API_KEY_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPES];

/**
 * API-key scopes available to a given global role. Without Enterprise
 * entitlements every role receives the full fair-code set; ownership-only
 * narrowing is applied by the caller.
 */
export const getApiKeyScopesForRole = (_role: string): ApiKeyScope[] => [...API_KEY_SCOPES];

/** Scopes that only an instance owner's API key may hold (none in fair-code). */
export const getOwnerOnlyApiKeyScopes = (): ApiKeyScope[] => [];
