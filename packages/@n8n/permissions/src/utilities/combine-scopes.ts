import type { MaskLevels, Scope, ScopeLevels } from '../types';

/**
 * Flatten a principal's scope levels into a single set. Global scopes always
 * apply; project and resource scopes are kept only if they pass the sharing mask
 * (when one is supplied).
 */
export const combineScopes = (userScopes: ScopeLevels, masks?: MaskLevels): Set<Scope> => {
	const global = userScopes.global ?? [];
	const nonGlobal = [...(userScopes.project ?? []), ...(userScopes.resource ?? [])];
	const maskedNonGlobal = masks
		? nonGlobal.filter((scope) => masks.sharing.includes(scope))
		: nonGlobal;

	return new Set<Scope>([...global, ...maskedNonGlobal]);
};
