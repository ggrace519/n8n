import { combineScopes } from './combine-scopes';
import type { MaskLevels, Scope, ScopeLevels, ScopeOptions } from '../types';

/**
 * Check whether a principal's scopes satisfy the required scope(s). `oneOf`
 * (default) passes if any required scope is held; `allOf` requires all. An empty
 * requirement list never passes.
 */
export const hasScope = (
	scope: Scope | Scope[],
	userScopes: ScopeLevels,
	masks?: MaskLevels,
	options: ScopeOptions = { mode: 'oneOf' },
): boolean => {
	const required = Array.isArray(scope) ? scope : [scope];
	if (required.length === 0) return false;

	const held = combineScopes(userScopes, masks);

	return options.mode === 'allOf'
		? required.every((s) => held.has(s))
		: required.some((s) => held.has(s));
};
