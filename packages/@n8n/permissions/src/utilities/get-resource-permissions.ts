import { RESOURCES } from '../constants';
import type { Resource, ResourceOperation, Scope } from '../types';

/** A per-resource map of which operations a principal is permitted. */
export type PermissionsRecord = {
	[R in Resource]: Partial<Record<ResourceOperation<R>, boolean>>;
};

/**
 * Turn a flat scope list into a `{ resource: { operation: true } }` record,
 * with an entry for every known resource (empty when no scope grants it).
 */
export const getResourcePermissions = (scopes: Scope[] = []): PermissionsRecord => {
	const record = {} as Record<Resource, Record<string, boolean>>;
	for (const resource of Object.keys(RESOURCES) as Resource[]) {
		record[resource] = {};
	}

	for (const scope of scopes) {
		const [resource, operation] = scope.split(':') as [Resource, string];
		record[resource][operation] = true;
	}

	return record as PermissionsRecord;
};
