import { z } from 'zod';

import {
	PROJECT_OWNER_ROLE_SLUG,
	PROJECT_ADMIN_ROLE_SLUG,
	PROJECT_EDITOR_ROLE_SLUG,
	PROJECT_VIEWER_ROLE_SLUG,
	PROJECT_CHAT_USER_ROLE_SLUG,
} from './constants';
import { ALL_SCOPES } from './scope-information';
import type { Scope } from './types';

/** The namespace a role belongs to. */
export const roleNamespaceSchema = z.enum([
	'global',
	'project',
	'credential',
	'workflow',
	'secretsProviderConnection',
]);

// ----------------------------------
//          global roles
// ----------------------------------

export const globalRoleSchema = z.enum([
	'global:owner',
	'global:admin',
	'global:member',
	'global:chatUser',
]);

/** Global roles that can be assigned to a user (the instance owner is fixed). */
export const assignableGlobalRoleSchema = z.enum([
	'global:admin',
	'global:member',
	'global:chatUser',
]);

// ----------------------------------
//          project roles
// ----------------------------------

/** All built-in project roles, including the fixed personal-project owner. */
export const systemProjectRoleSchema = z.enum([
	PROJECT_OWNER_ROLE_SLUG,
	PROJECT_ADMIN_ROLE_SLUG,
	PROJECT_EDITOR_ROLE_SLUG,
	PROJECT_VIEWER_ROLE_SLUG,
	PROJECT_CHAT_USER_ROLE_SLUG,
]);

/** Project roles assignable to a member of a team project (excludes the fixed
 * personal-project owner). */
export const assignableProjectRoleSchema = z.enum([
	PROJECT_ADMIN_ROLE_SLUG,
	PROJECT_EDITOR_ROLE_SLUG,
	PROJECT_VIEWER_ROLE_SLUG,
	PROJECT_CHAT_USER_ROLE_SLUG,
]);

/** A user-defined custom project role, namespaced under `custom:`. */
export const customProjectRoleSchema = z
	.string()
	.regex(/^custom:.+/, { message: 'Custom role slugs must be namespaced under "custom:"' });

/** Any project role — built-in or custom. */
export const projectRoleSchema = z.union([systemProjectRoleSchema, customProjectRoleSchema]);

/** Roles assignable within a team project (built-in assignable + custom). */
export const teamRoleSchema = z.union([assignableProjectRoleSchema, customProjectRoleSchema]);

// ----------------------------------
//        resource sharing roles
// ----------------------------------

export const credentialSharingRoleSchema = z.enum(['credential:owner', 'credential:user']);

export const workflowSharingRoleSchema = z.enum(['workflow:owner', 'workflow:editor']);

export const secretsProviderConnectionSharingRoleSchema = z.enum([
	'secretsProviderConnection:owner',
	'secretsProviderConnection:user',
]);

// ----------------------------------
//            roles & scopes
// ----------------------------------

/** Any built-in or custom role slug across all namespaces. */
export const roleSchema = z.union([
	globalRoleSchema,
	projectRoleSchema,
	credentialSharingRoleSchema,
	workflowSharingRoleSchema,
	secretsProviderConnectionSharingRoleSchema,
]);

export type Role = z.infer<typeof roleSchema>;

/** Validates a fully-qualified scope string against the known catalog. */
export const scopeSchema = z.enum(ALL_SCOPES as [Scope, ...Scope[]]);
