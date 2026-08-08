import type { AuthPrincipal, Scope } from '../types';

/** The global scopes attached to a principal's role. */
export const getGlobalScopes = (principal: AuthPrincipal): Scope[] =>
	principal.role.scopes.map((scope) => scope.slug);
