import { API_KEY_RESOURCES } from './constants';
import { COUPLED_HIDDEN_SCOPES } from './roles/scopes/global-scopes';
import type { ApiKeyScope, Scope } from './types';

/** Every scope grantable to a public API key, flattened from the catalog. */
export const API_KEY_SCOPES: ApiKeyScope[] = Object.entries(API_KEY_RESOURCES).flatMap(
	([resource, operations]) => operations.map((op) => `${resource}:${op}` as ApiKeyScope),
);

/**
 * Scopes an instance owner's API key carries by default. Not quite the full set:
 * community-package management is opt-in and has to be granted explicitly, so a
 * key holding only these scopes is refused by the `/community-packages` routes.
 */
export const OWNER_API_KEY_SCOPES: ApiKeyScope[] = API_KEY_SCOPES.filter(
	(scope) => !scope.startsWith('communityPackage:'),
);

/**
 * API-key scopes available for a given principal: the scopes of its global
 * role intersected with the set addressable via a public API key. Accepts any
 * `AuthPrincipal`-shaped input (a user, or a role row with its scopes loaded).
 */
export const getApiKeyScopesForRole = (principal: {
	role: { scopes: Array<{ slug: string }> };
}): ApiKeyScope[] => {
	const held = new Set((principal.role.scopes ?? []).map((scope) => scope.slug));
	// Legacy public-API scopes ride along with their coupled modern scope
	// (e.g. workflow:activate with workflow:publish).
	for (const [hidden, coupledTo] of Object.entries(COUPLED_HIDDEN_SCOPES) as Array<
		[Scope, Scope]
	>) {
		if (held.has(coupledTo)) held.add(hidden);
	}
	return API_KEY_SCOPES.filter((scope) => held.has(scope));
};

/** Scopes that only an instance owner's API key may hold (none in fair-code). */
export const getOwnerOnlyApiKeyScopes = (): ApiKeyScope[] => [];
