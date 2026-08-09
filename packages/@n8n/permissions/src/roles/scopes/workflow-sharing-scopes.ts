import type { Scope } from '../../types';
import { pick } from './scope-filters';

/**
 * Scopes retained on a workflow through an OWNER sharing relation. Project-
 * level operations (list, activate/deactivate) stay outside the per-item mask;
 * `execution:reveal` rides along so owners can reveal redacted executions of
 * their own workflows.
 */
export const WORKFLOW_SHARING_OWNER_SCOPES: Scope[] = [
	...pick(
		['workflow'],
		[
			'read',
			'update',
			'delete',
			'move',
			'share',
			'unshare',
			'execute',
			'execute-chat',
			'export',
			'publish',
			'unpublish',
			'enableRedaction',
			'disableRedaction',
		],
	),
	...pick(['execution'], ['reveal']),
];

/** Scopes a workflow *editor* (sharee) has — edit and run, but no ownership ops. */
export const WORKFLOW_SHARING_EDITOR_SCOPES: Scope[] = pick(
	['workflow'],
	['read', 'update', 'execute', 'execute-chat', 'export', 'publish', 'unpublish'],
);
