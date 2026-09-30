import { ALL_SCOPES } from '../../scope-information';
import type { Scope } from '../../types';
import { pick } from './scope-filters';

/**
 * Legacy scopes kept in the catalog for public-API key compatibility but
 * hidden from role scope sets: they are implicitly coupled to their modern
 * counterpart (`workflow:activate` ⇔ `workflow:publish`, etc.). API keys
 * receive them through that coupling (see `getApiKeyScopesForRole`).
 */
export const COUPLED_HIDDEN_SCOPES: Partial<Record<Scope, Scope>> = {
	'workflow:activate': 'workflow:publish',
	'workflow:deactivate': 'workflow:unpublish',
};

const VISIBLE_SCOPES: Scope[] = ALL_SCOPES.filter(
	(scope) => COUPLED_HIDDEN_SCOPES[scope] === undefined,
);

/**
 * The instance owner and admin hold every (visible) scope. In community n8n
 * the two are behaviourally equivalent at the scope level — the owner is
 * simply the single, undeletable account — so both map to the full catalog.
 */
export const GLOBAL_OWNER_SCOPES: Scope[] = [...VISIBLE_SCOPES];

export const GLOBAL_ADMIN_SCOPES: Scope[] = [...VISIBLE_SCOPES];

/**
 * A member self-serves: manage tags/annotations, see other users (to share
 * with), read shared variables, and use chat. Members do NOT hold global
 * workflow/credential or user-management scopes — they reach their own
 * resources through their personal project's scopes.
 */
export const GLOBAL_MEMBER_SCOPES: Scope[] = [
	// Workflow tags are instance-wide: a member may add and rename them, but
	// deleting one strips it from every workflow on the instance, so that stays
	// with owners/admins. Annotation tags keep `delete` — they belong to the
	// execution-annotation flow members own.
	...pick(['tag'], ['create', 'read', 'update', 'list']),
	...pick(['annotationTag'], ['create', 'read', 'update', 'delete', 'list']),
	// Only GLOBAL variables: project-variable visibility comes from project
	// roles, so members never see variables of projects they are not in.
	...pick(['variable'], ['read', 'list']),
	...pick(['user'], ['list']),
	...pick(['chatHub'], ['message']),
	...pick(['banner'], ['dismiss']),
	// Own public-API keys only: the key service scopes create/update/rotate to the
	// caller's keys, and managing other users' keys stays behind `apiKey:manage`.
	...pick(['apiKey'], ['create', 'update']),
];

/** A chat-only user can converse with chat-enabled workflows and nothing else. */
export const GLOBAL_CHAT_USER_SCOPES: Scope[] = [
	...pick(['chatHub'], ['message']),
	...pick(['banner'], ['dismiss']),
];
