import { API_KEY_RESOURCES } from './constants';
import type { ApiKeyScope } from './types';

/** Every scope grantable to a public API key, flattened from the catalog. */
export const API_KEY_SCOPES: ApiKeyScope[] = Object.entries(API_KEY_RESOURCES).flatMap(
	([resource, operations]) => operations.map((op) => `${resource}:${op}` as ApiKeyScope),
);

/** Scopes available to an instance owner's API key (the full set). */
export const OWNER_API_KEY_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPES];

/**
 * API-key scopes available for a given principal: the scopes of its global
 * role intersected with the set addressable via a public API key. Accepts any
 * `AuthPrincipal`-shaped input (a user, or a role row with its scopes loaded).
 */
export const getApiKeyScopesForRole = (principal: {
	role: { scopes: Array<{ slug: string }> };
}): ApiKeyScope[] => {
	const held = new Set((principal.role.scopes ?? []).map((scope) => scope.slug));
	return API_KEY_SCOPES.filter((scope) => held.has(scope));
};

/** Scopes that only an instance owner's API key may hold (none in fair-code). */
export const getOwnerOnlyApiKeyScopes = (): ApiKeyScope[] => [];
