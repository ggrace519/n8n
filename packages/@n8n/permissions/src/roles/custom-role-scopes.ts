import { RESOURCES } from '../constants';
import type { Resource, Scope } from '../types';

/**
 * Operations selectable when composing a custom **project** role, keyed by the
 * project-scoped resource they belong to. The custom-role editor type-checks its
 * scope strings against this map.
 */
export const PROJECT_CUSTOM_ROLE_OPERATIONS = {
	workflow: [...RESOURCES.workflow],
	credential: [...RESOURCES.credential],
	execution: [...RESOURCES.execution],
	folder: [...RESOURCES.folder],
	dataTable: [...RESOURCES.dataTable],
	projectVariable: [...RESOURCES.projectVariable],
	agent: [...RESOURCES.agent],
	chatHubAgent: [...RESOURCES.chatHubAgent],
	testRun: [...RESOURCES.testRun],
	workflowTags: [...RESOURCES.workflowTags],
	annotationTag: [...RESOURCES.annotationTag],
	credentialResolver: [...RESOURCES.credentialResolver],
	insights: [...RESOURCES.insights],
} satisfies Partial<Record<Resource, readonly string[]>>;

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
} satisfies Partial<Record<Resource, readonly string[]>>;

const scopesFromOperations = (ops: Partial<Record<Resource, readonly string[]>>): Scope[] =>
	Object.entries(ops).flatMap(([resource, operations]) =>
		(operations ?? []).map((op) => `${resource}:${op}` as Scope),
	);

/** Scopes a custom **project** role may grant (strict subset of the catalog). */
export const PROJECT_CUSTOM_ROLE_SCOPES = new Set<Scope>(
	scopesFromOperations(PROJECT_CUSTOM_ROLE_OPERATIONS),
);

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
	project: {
		Manage: [
			'project:create',
			'project:read',
			'project:update',
			'project:delete',
			'project:list',
		] as Scope[],
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
