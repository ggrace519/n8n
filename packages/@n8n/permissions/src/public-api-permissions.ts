import { API_KEY_RESOURCES } from './constants';
import { COUPLED_HIDDEN_SCOPES } from './roles/scopes/global-scopes';
import type { ApiKeyScope, Scope } from './types';

/** Every scope grantable to a public API key, flattened from the catalog. */
export const API_KEY_SCOPES: ApiKeyScope[] = Object.entries(API_KEY_RESOURCES).flatMap(
	([resource, operations]) => operations.map((op) => `${resource}:${op}` as ApiKeyScope),
);

/**
 * The RBAC scope that backs an API-key scope whose slug does not exist in
 * {@link RESOURCES}. The public API catalog names some resources differently
 * from the RBAC catalog (`dataTableRow` against `dataTable`'s row operations)
 * and exposes a few operations the RBAC catalog has no entry for at all
 * (`testRun:create`). Since a key may only hold what its principal's role
 * holds, and that check is an exact slug match, such a scope would otherwise be
 * grantable to nobody and its routes would answer 403 to everyone.
 *
 * Each entry is taken from the route that requires it: every one of these
 * endpoints already pairs its `publicApiScope(...)` with the `projectScope(...)`
 * it enforces, so the backing scope here is the one the request is checked
 * against anyway. This grants nothing extra — it only makes the key-level gate
 * reachable for a principal that holds the underlying permission.
 */
export const API_KEY_SCOPE_BACKED_BY: Partial<Record<ApiKeyScope, Scope>> = {
	'dataTableColumn:read': 'dataTable:readColumn',
	'dataTableColumn:create': 'dataTable:writeColumn',
	'dataTableColumn:update': 'dataTable:writeColumn',
	'dataTableColumn:delete': 'dataTable:writeColumn',
	'dataTableRow:read': 'dataTable:readRow',
	'dataTableRow:create': 'dataTable:writeRow',
	'dataTableRow:update': 'dataTable:writeRow',
	'dataTableRow:upsert': 'dataTable:writeRow',
	'dataTableRow:delete': 'dataTable:writeRow',
	'executionTags:list': 'workflow:read',
	'executionTags:update': 'workflow:update',
	'testRun:create': 'workflow:execute',
	'testRun:cancel': 'workflow:execute',
};

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
	return API_KEY_SCOPES.filter((scope) => {
		const backingScope = API_KEY_SCOPE_BACKED_BY[scope];
		return held.has(backingScope ?? scope);
	});
};

/** Scopes that only an instance owner's API key may hold (none in fair-code). */
export const getOwnerOnlyApiKeyScopes = (): ApiKeyScope[] => [];
