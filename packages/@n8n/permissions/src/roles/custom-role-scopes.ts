import { RESOURCES } from '../constants';
import type { Resource, ResourceOperation, Scope } from '../types';

/** A partial resource→operations map whose operations are checked per resource. */
type ResourceOperations = { [R in Resource]?: ReadonlyArray<ResourceOperation<R>> };

/**
 * Operations the custom **project** role editor renders as checkboxes, keyed by
 * the project-scoped resource they belong to. One-for-one with the
 * `projectRoles.<resource>:<operation>` i18n keys — the editor builds its labels
 * and tooltips from these strings, so every entry needs a translation.
 *
 * Deliberately narrower than the whitelist below: scopes the editor adds
 * implicitly (`:list`, `:listProject`, coupled `activate`/`deactivate`) get no
 * checkbox and live in {@link PROJECT_CUSTOM_ROLE_HIDDEN_OPERATIONS}.
 */
export const PROJECT_CUSTOM_ROLE_OPERATIONS = {
	project: ['read', 'update', 'delete', 'export'],
	folder: ['read', 'update', 'create', 'move', 'delete'],
	workflow: [
		'read',
		'export',
		'import',
		'execute',
		'execute-chat',
		'update',
		'create',
		'share',
		'move',
		'delete',
		'publish',
		'unpublish',
		'enableRedaction',
		'disableRedaction',
	],
	agent: ['create', 'read', 'execute', 'update', 'delete', 'list', 'publish', 'unpublish'],
	credential: [
		'read',
		'update',
		'create',
		'createEndUser',
		'share',
		'unshare',
		'move',
		'connect',
		'delete',
	],
	execution: ['reveal'],
	dataTable: [
		'read',
		'update',
		'create',
		'delete',
		'readRow',
		'writeRow',
		'readColumn',
		'writeColumn',
	],
	projectVariable: ['read', 'update', 'create', 'delete'],
	sourceControl: ['pull', 'push', 'manage'],
	externalSecretsProvider: ['read', 'create', 'update', 'delete', 'sync'],
	externalSecret: ['list'],
} satisfies ResourceOperations;

/**
 * Project-scoped operations a custom project role may hold that the editor never
 * renders: the `:list`/`:listProject` twins it auto-selects alongside `:read`,
 * the `activate`/`deactivate` scopes coupled to `publish`/`unpublish`, and
 * resources reachable only through the API.
 */
const PROJECT_CUSTOM_ROLE_HIDDEN_OPERATIONS = {
	project: ['list'],
	folder: ['list'],
	workflow: ['list', 'activate', 'deactivate', 'unshare'],
	agent: ['manage'],
	credential: ['list', 'shareGlobally', 'manageInstance'],
	execution: ['delete', 'read', 'retry', 'list', 'get'],
	dataTable: ['list', 'listProject'],
	projectVariable: ['list'],
	externalSecretsProvider: ['list'],
	chatHubAgent: [...RESOURCES.chatHubAgent],
	testRun: [...RESOURCES.testRun],
	workflowTags: [...RESOURCES.workflowTags],
	annotationTag: [...RESOURCES.annotationTag],
	credentialResolver: [...RESOURCES.credentialResolver],
	insights: [...RESOURCES.insights],
} satisfies ResourceOperations;

/**
 * Operations selectable when composing a custom **global** role, keyed by the
 * instance-scoped resource they belong to.
 */
export const GLOBAL_CUSTOM_ROLE_OPERATIONS = {
	user: [...RESOURCES.user],
	tag: [...RESOURCES.tag],
	project: ['create', 'read', 'update', 'delete', 'list'],
	communityPackage: [...RESOURCES.communityPackage],
	variable: [...RESOURCES.variable],
	insights: [...RESOURCES.insights],
	apiKey: [...RESOURCES.apiKey],
	role: [...RESOURCES.role],
	ldap: [...RESOURCES.ldap],
	saml: ['manage'],
	oidc: ['manage'],
	logStreaming: ['manage'],
	license: ['manage'],
	securitySettings: ['manage'],
	securityAudit: ['generate'],
	auditLogs: ['manage'],
	banner: ['dismiss'],
	chatHub: [...RESOURCES.chatHub],
	aiAssistant: ['manage'],
	instanceAi: [...RESOURCES.instanceAi],
	mcp: [...RESOURCES.mcp],
	mcpApiKey: [...RESOURCES.mcpApiKey],
	encryptionKey: ['manage'],
	externalSecretsProvider: [...RESOURCES.externalSecretsProvider],
	externalSecret: ['list'],
	sourceControl: [...RESOURCES.sourceControl],
	eventBusDestination: [...RESOURCES.eventBusDestination],
	orchestration: [...RESOURCES.orchestration],
	workersView: ['manage'],
	breakingChanges: [...RESOURCES.breakingChanges],
	provisioning: ['manage'],
	roleMappingRule: [...RESOURCES.roleMappingRule],
	otel: ['manage'],
	agent: ['manage'],
} satisfies ResourceOperations;

const scopesFromOperations = (ops: ResourceOperations): Scope[] =>
	Object.entries(ops).flatMap(([resource, operations]) =>
		(operations ?? []).map((op) => `${resource}:${op}` as Scope),
	);

/** Scopes a custom **project** role may grant (strict subset of the catalog). */
export const PROJECT_CUSTOM_ROLE_SCOPES = new Set<Scope>([
	...scopesFromOperations(PROJECT_CUSTOM_ROLE_OPERATIONS),
	...scopesFromOperations(PROJECT_CUSTOM_ROLE_HIDDEN_OPERATIONS),
]);

/** Scopes a custom **global** role may grant (strict subset of the catalog). */
export const GLOBAL_CUSTOM_ROLE_SCOPES = new Set<Scope>(
	scopesFromOperations(GLOBAL_CUSTOM_ROLE_OPERATIONS),
);

/** Custom-role scope whitelists keyed by role type. */
export const CUSTOM_ROLE_SCOPE_WHITELIST = {
	project: PROJECT_CUSTOM_ROLE_SCOPES,
	global: GLOBAL_CUSTOM_ROLE_SCOPES,
} as const;

/**
 * UI groupings of global custom-role scopes into labelled bundles (e.g. the
 * settings "Manage" bundle that couples chat, AI-assistant and MCP scopes).
 */
export const GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS = {
	user: {
		Manage: [
			'user:create',
			'user:read',
			'user:update',
			'user:delete',
			'user:list',
			'user:changeRole',
			'user:resetPassword',
			'user:enforceMfa',
			'user:generateInviteLink',
		] as Scope[],
	},
	// `role:read` rides along with both options: the roles list is gated on it,
	// so neither option is usable without it. "Manage" is a strict superset of
	// "Manage project roles" — the editor renders the latter as implied when the
	// former is fully selected.
	role: {
		'Manage project roles': ['role:read', 'role:manageProject'] as Scope[],
		Manage: ['role:read', 'role:manage', 'role:manageProject'] as Scope[],
	},
	// `apiKey:manage` is what extends reach to other users' keys; listing and
	// deleting one's own keys needs no scope at all (see ApiKeysController).
	apiKey: {
		'Manage own': ['apiKey:create', 'apiKey:update'] as Scope[],
		'Manage all': ['apiKey:create', 'apiKey:update', 'apiKey:manage'] as Scope[],
	},
	tag: {
		Manage: ['tag:create', 'tag:read', 'tag:update', 'tag:delete', 'tag:list'] as Scope[],
	},
	// Creating team projects only: managing existing projects is granted per
	// project through project roles, not instance-wide from a custom role.
	project: {
		Create: ['project:create'] as Scope[],
	},
	insights: {
		View: ['insights:list', 'insights:read'] as Scope[],
	},
	settings: {
		Manage: [
			'chatHub:manage',
			'chatHub:message',
			'aiAssistant:manage',
			'instanceAi:manage',
			'instanceAi:message',
			'instanceAi:gateway',
			'instanceAi:eval',
			'mcp:manage',
			'mcp:oauth',
			'mcpApiKey:create',
			'mcpApiKey:rotate',
			'securitySettings:manage',
			'encryptionKey:manage',
			'license:manage',
			'logStreaming:manage',
			'auditLogs:manage',
			'otel:manage',
		] as Scope[],
	},
} as const;
