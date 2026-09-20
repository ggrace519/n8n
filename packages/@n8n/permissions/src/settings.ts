import type { Scope } from './types';

/**
 * Scopes the personal-project owner holds only while the corresponding
 * personal-space security setting is enabled. They are the single source of
 * truth: `PERSONAL_PROJECT_OWNER_SCOPES` excludes them from its base set so the
 * setting toggle (see `SecuritySettingsService`) is what adds or removes them,
 * and both are assembled from the arrays below.
 */
export const PERSONAL_SPACE_PUBLISHING_SCOPES = [
	'workflow:publish',
	'workflow:unpublish',
] as Scope[];

export const PERSONAL_SPACE_SHARING_SCOPES = ['workflow:share', 'credential:share'] as Scope[];

/** Every scope the personal-space settings conditionally grant. */
export const PERSONAL_SPACE_SETTING_SCOPES: Scope[] = [
	...PERSONAL_SPACE_PUBLISHING_SCOPES,
	...PERSONAL_SPACE_SHARING_SCOPES,
];

/**
 * Instance settings that conditionally widen the personal-project owner's scopes.
 * Both default to enabled when the setting row is absent, preserving the
 * community behaviour where a user fully controls their own personal project.
 */
export const PERSONAL_SPACE_PUBLISHING_SETTING = {
	key: 'personalProject.publishing.enabled',
	scopes: PERSONAL_SPACE_PUBLISHING_SCOPES,
};

export const PERSONAL_SPACE_SHARING_SETTING = {
	key: 'personalProject.sharing.enabled',
	scopes: PERSONAL_SPACE_SHARING_SCOPES,
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
