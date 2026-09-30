import { PERSONAL_SPACE_SETTING_SCOPES } from '../../settings';
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

/**
 * Personal projects don't have project variables (a team-project feature),
 * so the personal owner carries no `projectVariable:*` scopes.
 *
 * The sharing/publishing scopes are excluded from this base set and granted
 * separately by the personal-space security settings (see `settings.ts` and
 * `SecuritySettingsService`), so a disabled setting can withhold them. They
 * default to enabled, so a personal owner keeps full control out of the box.
 */
export const PERSONAL_PROJECT_OWNER_SCOPES: Scope[] = FULL_PROJECT_SCOPES.filter(
	(scope) =>
		!scope.startsWith('projectVariable:') && !PERSONAL_SPACE_SETTING_SCOPES.includes(scope),
);

/**
 * A team-project admin has full control of the project's resources except
 * re-sharing workflows out of the project — that stays with the personal
 * owner / global admins.
 */
export const REGULAR_PROJECT_ADMIN_SCOPES: Scope[] = FULL_PROJECT_SCOPES.filter(
	(scope) => scope !== 'workflow:share' && scope !== 'workflow:unshare',
);

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
