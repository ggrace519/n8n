import type { Scope } from '../../types';
import { pick } from './scope-filters';

/** Scopes a workflow *owner* retains on a shared workflow. */
export const WORKFLOW_SHARING_OWNER_SCOPES: Scope[] = pick(
	['workflow'],
	[
		'read',
		'update',
		'delete',
		'list',
		'move',
		'share',
		'unshare',
		'execute',
		'execute-chat',
		'activate',
		'deactivate',
		'publish',
		'unpublish',
	],
);

/** Scopes a workflow *editor* (sharee) has — edit and run, but not share/delete. */
export const WORKFLOW_SHARING_EDITOR_SCOPES: Scope[] = pick(
	['workflow'],
	['read', 'update', 'list', 'execute', 'execute-chat', 'activate', 'deactivate'],
);
