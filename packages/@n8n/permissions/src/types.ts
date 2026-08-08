import type { RESOURCES, API_KEY_RESOURCES } from './constants';

// ----------------------------------
//           scopes
// ----------------------------------

type ResourceMap = typeof RESOURCES;

/** A known RBAC resource, e.g. `workflow`, `credential`, `user`. */
export type Resource = keyof ResourceMap;

/** An operation valid for a given resource. */
export type ResourceOperation<R extends Resource = Resource> = ResourceMap[R][number];

/** A fully-qualified scope string, e.g. `workflow:read`. */
export type Scope = {
	[R in Resource]: `${R & string}:${ResourceMap[R][number]}`;
}[Resource];

type ApiKeyResourceMap = typeof API_KEY_RESOURCES;

/** A resource addressable via a public API key. */
export type ApiKeyResource = keyof ApiKeyResourceMap;

/** A scope grantable to a public API key. */
export type ApiKeyScope = {
	[R in ApiKeyResource]: `${R & string}:${ApiKeyResourceMap[R][number]}`;
}[ApiKeyResource];

/** Human-readable metadata for a scope, surfaced in the custom-roles UI. */
export interface ScopeInformation {
	displayName: string;
	description: string;
}

// ----------------------------------
//        scope levels & checks
// ----------------------------------

/** The level at which a scope is granted. */
export type ScopeLevel = 'global' | 'project' | 'resource';

/**
 * A user's scopes bucketed by level. `global` scopes always apply; `project`
 * and `resource` scopes are subject to sharing masks.
 */
export interface ScopeLevels {
	global: Scope[];
	project?: Scope[];
	resource?: Scope[];
}

/** Sharing masks applied to non-global scope levels. */
export interface MaskLevels {
	sharing: Scope[];
}

/** How a multi-scope check is evaluated. */
export interface ScopeOptions {
	/** `oneOf` (default): pass if any scope matches. `allOf`: require all. */
	mode: 'oneOf' | 'allOf';
}

// ----------------------------------
//              roles
// ----------------------------------

export type GlobalRole = 'global:owner' | 'global:admin' | 'global:member' | 'global:chatUser';

export type ProjectRole =
	| 'project:personalOwner'
	| 'project:admin'
	| 'project:editor'
	| 'project:viewer'
	| 'project:chatUser';

export type CredentialSharingRole = 'credential:owner' | 'credential:user';

export type WorkflowSharingRole = 'workflow:owner' | 'workflow:editor';

export type SecretsProviderConnectionSharingRole =
	| 'secretsProviderConnection:owner'
	| 'secretsProviderConnection:user';

/** Every built-in role slug across all namespaces. */
export type AllRoleTypes =
	| GlobalRole
	| ProjectRole
	| CredentialSharingRole
	| WorkflowSharingRole
	| SecretsProviderConnectionSharingRole;

/** The namespace a role belongs to. */
export type RoleNamespace =
	| 'global'
	| 'project'
	| 'credential'
	| 'workflow'
	| 'secretsProviderConnection';

/** A fully described role, as surfaced to the frontend. */
export interface RoleObject {
	slug: AllRoleTypes;
	displayName: string;
	scopes: Scope[];
	description: string;
	licensed: boolean;
	systemRole: boolean;
	roleType: RoleNamespace;
}

/** All built-in roles grouped by namespace. */
export type AllRolesMap = {
	global: RoleObject[];
	project: RoleObject[];
	credential: RoleObject[];
	workflow: RoleObject[];
	secretsProviderConnection: RoleObject[];
};

/**
 * The minimal shape needed to resolve a principal's global scopes: a role slug
 * plus the scope objects attached to that role.
 */
export interface AuthPrincipal {
	role: {
		slug: string;
		scopes: Array<{ slug: Scope }>;
	};
}
