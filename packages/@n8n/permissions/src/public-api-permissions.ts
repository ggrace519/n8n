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
 * API-key scopes a principal may hold by virtue of a **project** role. The
 * key-level gate only checks that the key carries the scope, so a project-derived
 * scope is safe only when every public-API route requiring it also restricts the
 * caller to resources they can reach (`projectScope`, `assertProjectScope`,
 * `getProjectWithScope`, or a list filtered to their projects). Each scope here
 * was audited against its routes.
 *
 * Deliberately absent until their routes gain a per-project check: `project:update`
 * and `project:delete` (handlers act on any project id), `credential:list` (lists
 * every project credential), `insights:read` (instance-wide summary), and
 * `workflow:import` (conflict reports describe workflows in other projects).
 */
export const PROJECT_CHECKED_API_KEY_SCOPES: ApiKeyScope[] = [
	'credential:create',
	'credential:read',
	'credential:update',
	'credential:delete',
	'credential:move',
	'dataTable:create',
	'dataTable:read',
	'dataTable:update',
	'dataTable:delete',
	'dataTable:list',
	'dataTableColumn:read',
	'dataTableColumn:create',
	'dataTableColumn:update',
	'dataTableColumn:delete',
	'dataTableRow:read',
	'dataTableRow:create',
	'dataTableRow:update',
	'dataTableRow:upsert',
	'dataTableRow:delete',
	'execution:read',
	'execution:list',
	'execution:delete',
	'execution:retry',
	'execution:stop',
	'executionTags:list',
	'executionTags:update',
	'folder:create',
	'folder:read',
	'folder:update',
	'folder:delete',
	'folder:list',
	'testRun:read',
	'testRun:list',
	'testRun:create',
	'testRun:cancel',
	'project:export',
	'workflow:create',
	'workflow:read',
	'workflow:update',
	'workflow:delete',
	'workflow:list',
	'workflow:move',
	'workflow:export',
	'workflow:activate',
	'workflow:deactivate',
	'workflowTags:list',
	'workflowTags:update',
];

/**
 * Held scopes, with each legacy public-API scope present exactly when its modern
 * counterpart is (workflow:activate ⇔ workflow:publish). Project role sets carry the
 * legacy scopes directly via `allOps`, so a direct hold is ignored — otherwise a
 * personal owner with publishing disabled could still grant `workflow:activate`.
 */
const withCoupledScopes = (scopes: Iterable<string>): Set<string> => {
	const held = new Set(scopes);
	for (const [hidden, coupledTo] of Object.entries(COUPLED_HIDDEN_SCOPES) as Array<
		[Scope, Scope]
	>) {
		if (held.has(coupledTo)) held.add(hidden);
		else held.delete(hidden);
	}
	return held;
};

const isBackedBy = (scope: ApiKeyScope, held: Set<string>) =>
	held.has(API_KEY_SCOPE_BACKED_BY[scope] ?? scope);

/**
 * API-key scopes available to a principal: every catalog scope backed by its
 * global role, plus the {@link PROJECT_CHECKED_API_KEY_SCOPES} backed by any of
 * its project roles.
 */
export const getApiKeyScopesForPrincipal = (
	globalScopes: Iterable<string>,
	projectScopes: Iterable<string>,
): ApiKeyScope[] => {
	const heldGlobally = withCoupledScopes(globalScopes);
	const heldInProjects = withCoupledScopes(projectScopes);
	const projectGrantable = new Set(PROJECT_CHECKED_API_KEY_SCOPES);

	return API_KEY_SCOPES.filter(
		(scope) =>
			isBackedBy(scope, heldGlobally) ||
			(projectGrantable.has(scope) && isBackedBy(scope, heldInProjects)),
	);
};

/**
 * API-key scopes backed by a principal's global role alone. For contexts with no
 * project relations to consult (e.g. the scopes-column backfill migration); user
 * key issuance goes through `ApiKeyScopesService`, which adds project roles.
 */
export const getApiKeyScopesForRole = (principal: {
	role: { scopes: Array<{ slug: string }> };
}): ApiKeyScope[] =>
	getApiKeyScopesForPrincipal(
		(principal.role.scopes ?? []).map((scope) => scope.slug),
		[],
	);
