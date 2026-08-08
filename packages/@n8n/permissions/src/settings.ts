import type { Scope } from './types';

/**
 * Instance settings that conditionally widen the personal-project owner's scopes.
 * Both default to enabled when the setting row is absent, preserving the
 * community behaviour where a user fully controls their own personal project.
 */
export const PERSONAL_SPACE_PUBLISHING_SETTING = {
	key: 'personalProject.publishing.enabled',
	scopes: ['workflow:publish', 'workflow:unpublish'] as Scope[],
};

export const PERSONAL_SPACE_SHARING_SETTING = {
	key: 'personalProject.sharing.enabled',
	scopes: ['workflow:share', 'credential:share'] as Scope[],
};

/**
 * Gates extra scopes granted to system roles when external secrets are enabled.
 * External secrets is an Enterprise feature removed from this fork, so the map is
 * empty and the setting is off by default.
 */
export const EXTERNAL_SECRETS_SYSTEM_ROLES_ENABLED_SETTING = {
	key: 'externalSecrets.systemRoles.enabled',
	roleScopeMap: {} as Record<string, string[]>,
};
