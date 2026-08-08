import { RESOURCES } from '../../constants';
import type { Resource, Scope } from '../../types';

/** Build `${resource}:${op}` scopes for the given resources, keeping only
 * operations that actually exist on each resource. */
export const pick = (resources: Resource[], operations: string[]): Scope[] =>
	resources.flatMap((resource) =>
		(RESOURCES[resource] as readonly string[])
			.filter((op) => operations.includes(op))
			.map((op) => `${resource}:${op}` as Scope),
	);

/** Every scope for the given resources. */
export const allOps = (resources: Resource[]): Scope[] =>
	resources.flatMap((resource) =>
		(RESOURCES[resource] as readonly string[]).map((op) => `${resource}:${op}` as Scope),
	);

/** Read-only operations, used to grade viewer-style roles. */
export const READ_OPS = ['read', 'list', 'get', 'listProject', 'readRow', 'readColumn'];

/** Mutating operations available to editor-style roles (no sharing/ownership). */
export const WRITE_OPS = [
	'create',
	'update',
	'delete',
	'move',
	'execute',
	'execute-chat',
	'activate',
	'deactivate',
	'publish',
	'unpublish',
	'import',
	'export',
	'writeRow',
	'writeColumn',
	'retry',
	'reveal',
];

/** Sharing / ownership operations reserved for admin/owner roles. */
export const SHARE_OPS = [
	'share',
	'unshare',
	'shareGlobally',
	'createEndUser',
	'connect',
	'manageInstance',
];
