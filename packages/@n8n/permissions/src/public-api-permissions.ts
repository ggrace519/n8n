import { API_KEY_RESOURCES } from './constants';
import type { ApiKeyScope, RoleObject, Scope } from './types';

/** Every scope grantable to a public API key, flattened from the catalog. */
export const API_KEY_SCOPES: ApiKeyScope[] = Object.entries(API_KEY_RESOURCES).flatMap(
	([resource, operations]) => operations.map((op) => `${resource}:${op}` as ApiKeyScope),
);

/** Scopes available to an instance owner's API key (the full set). */
export const OWNER_API_KEY_SCOPES: ApiKeyScope[] = [...API_KEY_SCOPES];

/**
 * API-key scopes available for a given role: the role's own scopes intersected
 * with the set of scopes that are addressable via a public API key.
 */
export const getApiKeyScopesForRole = (input: {
	role: Pick<RoleObject, 'scopes'>;
}): ApiKeyScope[] => {
	const held = new Set<Scope>(input.role.scopes ?? []);
	return API_KEY_SCOPES.filter((scope) => held.has(scope as unknown as Scope));
};

/** Scopes that only an instance owner's API key may hold (none in fair-code). */
export const getOwnerOnlyApiKeyScopes = (): ApiKeyScope[] => [];
