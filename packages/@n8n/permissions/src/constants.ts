/**
 * Canonical catalog of RBAC resources and their operations.
 *
 * The order here is significant: `scope-information.ts` flattens this map into
 * `ALL_SCOPES` in insertion order, which is snapshot-tested. Keep new resources
 * and operations in a deliberate order.
 */
export const RESOURCES = {
	agent: [
		'create',
		'read',
		'update',
		'delete',
		'list',
		'execute',
		'publish',
		'unpublish',
		'manage',
	],
	aiAssistant: ['manage'],
	annotationTag: ['create', 'read', 'update', 'delete', 'list'],
	auditLogs: ['manage'],
	banner: ['dismiss'],
	community: ['register'],
	communityPackage: ['install', 'uninstall', 'update', 'list', 'manage'],
	credential: [
		'share',
		'unshare',
		'shareGlobally',
		'move',
		'connect',
		'createEndUser',
		'manageInstance',
		'create',
		'read',
		'update',
		'delete',
		'list',
	],
	externalSecretsProvider: ['sync', 'create', 'read', 'update', 'delete', 'list'],
	externalSecret: ['list'],
	eventBusDestination: ['test', 'create', 'read', 'update', 'delete', 'list'],
	ldap: ['sync', 'manage'],
	license: ['manage'],
	logStreaming: ['manage'],
	orchestration: ['read', 'list'],
	project: ['create', 'read', 'update', 'delete', 'list', 'export'],
	saml: ['manage'],
	securityAudit: ['generate'],
	securitySettings: ['manage'],
	sourceControl: ['pull', 'push', 'manage'],
	tag: ['create', 'read', 'update', 'delete', 'list'],
	user: [
		'resetPassword',
		'changeRole',
		'enforceMfa',
		'generateInviteLink',
		'create',
		'read',
		'update',
		'delete',
		'list',
	],
	variable: ['create', 'read', 'update', 'delete', 'list'],
	projectVariable: ['create', 'read', 'update', 'delete', 'list'],
	workersView: ['manage'],
	workflow: [
		'share',
		'unshare',
		'execute',
		'execute-chat',
		'export',
		'import',
		'move',
		'activate',
		'deactivate',
		'publish',
		'unpublish',
		'enableRedaction',
		'disableRedaction',
		'create',
		'read',
		'update',
		'delete',
		'list',
	],
	folder: ['create', 'read', 'update', 'delete', 'list', 'move'],
	insights: ['list', 'read'],
	oidc: ['manage'],
	provisioning: ['manage'],
	dataTable: [
		'create',
		'read',
		'update',
		'delete',
		'list',
		'readRow',
		'writeRow',
		'readColumn',
		'writeColumn',
		'listProject',
	],
	execution: ['delete', 'read', 'retry', 'list', 'get', 'reveal'],
	testRun: ['read', 'list'],
	workflowTags: ['update', 'list'],
	role: ['manage', 'read', 'manageProject'],
	mcp: ['manage', 'oauth'],
	mcpApiKey: ['create', 'rotate'],
	chatHub: ['manage', 'message'],
	chatHubAgent: ['create', 'read', 'update', 'delete', 'list'],
	breakingChanges: ['list', 'migrate'],
	apiKey: ['manage', 'list', 'create', 'delete', 'update'],
	encryptionKey: ['manage'],
	credentialResolver: ['create', 'read', 'update', 'delete', 'list'],
	instanceAi: ['message', 'manage', 'gateway', 'eval'],
	roleMappingRule: ['create', 'read', 'update', 'delete', 'list'],
	otel: ['manage'],
} as const;

/**
 * Catalog of resources/operations addressable via public API keys. This is a
 * deliberately narrower surface than {@link RESOURCES} and may expose operations
 * (e.g. `testRun:create`) that are managed differently in the UI RBAC catalog.
 */
export const API_KEY_RESOURCES = {
	credential: ['create', 'list', 'read', 'delete', 'move'],
	eventBusDestination: ['create', 'read', 'update', 'delete', 'list', 'test'],
	execution: ['delete', 'list', 'read'],
	folder: ['create', 'read', 'update', 'delete', 'list'],
	ldap: ['manage', 'sync'],
	oidc: ['manage'],
	otel: ['manage'],
	testRun: ['list', 'read', 'create', 'cancel'],
	project: ['create', 'delete', 'list', 'update'],
	saml: ['manage'],
	securityAudit: ['generate'],
	securitySettings: ['manage'],
	sourceControl: ['pull'],
	tag: ['create', 'delete', 'list', 'read', 'update'],
	user: ['changeRole', 'create', 'delete', 'list', 'read'],
	variable: ['create', 'delete', 'list', 'update'],
	workflow: ['activate', 'create', 'deactivate', 'delete', 'list', 'move', 'read', 'update'],
	workflowTags: ['list', 'update'],
} as const;

// Built-in role slugs. Global roles use the `global:*` namespace; the personal
// project owner and the three system team-project roles use `project:*`.
export const GLOBAL_OWNER_ROLE_SLUG = 'global:owner';
export const GLOBAL_ADMIN_ROLE_SLUG = 'global:admin';
export const GLOBAL_MEMBER_ROLE_SLUG = 'global:member';
export const GLOBAL_CHAT_USER_ROLE_SLUG = 'global:chatUser';
export const PROJECT_OWNER_ROLE_SLUG = 'project:personalOwner';
export const PROJECT_ADMIN_ROLE_SLUG = 'project:admin';
export const PROJECT_EDITOR_ROLE_SLUG = 'project:editor';
export const PROJECT_VIEWER_ROLE_SLUG = 'project:viewer';
export const PROJECT_CHAT_USER_ROLE_SLUG = 'project:chatUser';
