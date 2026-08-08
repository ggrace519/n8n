import { getGlobalScopes } from './get-global-scopes';
import type { AuthPrincipal, Scope, ScopeOptions } from '../types';

/**
 * Check whether a principal's *global* role satisfies the required scope(s).
 * `oneOf` (default) passes if any is held; `allOf` requires all. An empty
 * requirement list never passes.
 */
export const hasGlobalScope = (
	principal: AuthPrincipal,
	scope: Scope | Scope[],
	options: ScopeOptions = { mode: 'oneOf' },
): boolean => {
	const required = Array.isArray(scope) ? scope : [scope];
	if (required.length === 0) return false;

	const held = new Set(getGlobalScopes(principal));

	return options.mode === 'allOf'
		? required.every((s) => held.has(s))
		: required.some((s) => held.has(s));
};
