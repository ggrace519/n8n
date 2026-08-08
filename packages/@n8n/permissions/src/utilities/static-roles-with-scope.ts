import {
	CREDENTIALS_SHARING_SCOPE_MAP,
	GLOBAL_SCOPE_MAP,
	PROJECT_SCOPE_MAP,
	SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
	WORKFLOW_SHARING_SCOPE_MAP,
} from '../roles/role-maps';
import type { RoleNamespace, Scope } from '../types';

const NAMESPACE_MAPS: Record<RoleNamespace, Record<string, Scope[]>> = {
	global: GLOBAL_SCOPE_MAP,
	project: PROJECT_SCOPE_MAP,
	credential: CREDENTIALS_SHARING_SCOPE_MAP,
	workflow: WORKFLOW_SHARING_SCOPE_MAP,
	secretsProviderConnection: SECRETS_PROVIDER_CONNECTION_SHARING_SCOPE_MAP,
};

/**
 * The built-in roles in a namespace that hold *all* of the given scope(s),
 * returned in the namespace's role order.
 */
export const staticRolesWithScope = (
	namespace: RoleNamespace,
	scope: Scope | Scope[],
): string[] => {
	const required = Array.isArray(scope) ? scope : [scope];
	const map = NAMESPACE_MAPS[namespace];

	return Object.keys(map).filter((role) => required.every((s) => map[role].includes(s)));
};
