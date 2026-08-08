import {
	CREDENTIALS_SHARING_SCOPE_MAP,
	GLOBAL_SCOPE_MAP,
	PROJECT_SCOPE_MAP,
	SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
	WORKFLOW_SHARING_SCOPE_MAP,
} from '../roles/role-maps';
import type { AllRoleTypes, AuthPrincipal, Resource, Scope } from '../types';

/** Scopes for every built-in role, keyed by slug across all namespaces. */
export const COMBINED_ROLE_MAP: Record<AllRoleTypes, Scope[]> = {
	...GLOBAL_SCOPE_MAP,
	...PROJECT_SCOPE_MAP,
	...CREDENTIALS_SHARING_SCOPE_MAP,
	...WORKFLOW_SHARING_SCOPE_MAP,
	...SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
};

/** The scopes granted by a built-in role, optionally filtered to resources. */
export const getRoleScopes = (role: AllRoleTypes, filters?: Resource[]): Scope[] => {
	const scopes = COMBINED_ROLE_MAP[role] ?? [];
	if (!filters) return scopes;
	return scopes.filter((scope) => filters.includes(scope.split(':')[0] as Resource));
};

/** The scopes attached to an authenticated principal's role. */
export const getAuthPrincipalScopes = (principal: AuthPrincipal): Scope[] =>
	principal.role.scopes.map((scope) => scope.slug);
