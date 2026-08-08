import type { Resource, Scope } from '../../types';
import { allOps, pick, READ_OPS, WRITE_OPS } from './scope-filters';

/** Resources whose scopes are granted at the project level. */
const PROJECT_RESOURCES: Resource[] = [
	'workflow',
	'credential',
	'execution',
	'folder',
	'dataTable',
	'projectVariable',
	'agent',
	'chatHubAgent',
	'testRun',
	'workflowTags',
	'annotationTag',
	'credentialResolver',
	'insights',
];

/**
 * Full control of a project's resources — including sharing and end-user
 * credential management — plus management of the project itself. Shared by the
 * personal-project owner and a team-project admin.
 */
const FULL_PROJECT_SCOPES: Scope[] = [
	...allOps(PROJECT_RESOURCES),
	...pick(['project'], ['read', 'update', 'delete', 'export']),
];

export const PERSONAL_PROJECT_OWNER_SCOPES: Scope[] = [...FULL_PROJECT_SCOPES];

export const REGULAR_PROJECT_ADMIN_SCOPES: Scope[] = [...FULL_PROJECT_SCOPES];

/**
 * An editor creates and edits resources but cannot share them, manage end-user
 * credentials, or administer the project.
 */
export const PROJECT_EDITOR_SCOPES: Scope[] = [
	...pick(PROJECT_RESOURCES, [...READ_OPS, ...WRITE_OPS]),
	...pick(['project'], ['read']),
];

/** Read-only access to a project's resources. */
export const PROJECT_VIEWER_SCOPES: Scope[] = [
	...pick(PROJECT_RESOURCES, READ_OPS),
	...pick(['project'], ['read']),
];

/** Chat-only access: run chat-enabled workflows/agents, read nothing else. */
export const PROJECT_CHAT_USER_SCOPES: Scope[] = [
	...pick(['workflow'], ['execute-chat', 'read', 'list']),
	...pick(['agent', 'chatHubAgent'], ['execute', 'read', 'list']),
];
