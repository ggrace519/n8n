import { z } from 'zod';

import {
	PROJECT_OWNER_ROLE_SLUG,
	PROJECT_ADMIN_ROLE_SLUG,
	PROJECT_EDITOR_ROLE_SLUG,
	PROJECT_VIEWER_ROLE_SLUG,
	PROJECT_CHAT_USER_ROLE_SLUG,
} from './constants';
import { ALL_SCOPES } from './scope-information';
import type { RoleObject, Scope } from './types';

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

/** Any role slug assignable to a user. Only the fixed instance-owner role is
 * rejected here; whether the role exists (built-in or custom) is a runtime
 * concern of the role service. */
export const assignableGlobalRoleSchema = z.string().refine((value) => value !== 'global:owner', {
	message: 'This global role value is not assignable',
});

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

/** Any project role — built-in or custom. Custom role slugs are generated
 * free-form under the `project:` or `custom:` namespace
 * (e.g. `project:<name>-<suffix>`), so this validates the namespace only;
 * existence is a runtime concern of the role service. */
export const projectRoleSchema = z.string().regex(/^(project|custom):.+/);

/** Roles assignable within a team project: any project role except the fixed
 * personal-project owner. */
export const teamRoleSchema = z
	.string()
	.refine((value) => /^(project|custom):.+/.test(value) && value !== PROJECT_OWNER_ROLE_SLUG, {
		message: 'This project role is not assignable in a team project',
	});

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

/** A fully-described role DTO: slug plus display metadata and granted scopes. */
export type Role = RoleObject;

/** A validated role slug (any built-in or custom role). */
export type RoleSlug = z.infer<typeof roleSchema>;

/**
 * Validates a fully-qualified scope string against the known catalog. Reports a
 * short 'Invalid scope' rather than zod's default, which lists all ~180 scopes.
 */
export const scopeSchema = z.enum(ALL_SCOPES as [Scope, ...Scope[]], {
	errorMap: () => ({ message: 'Invalid scope' }),
});
