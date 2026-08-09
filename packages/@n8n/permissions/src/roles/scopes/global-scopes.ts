import { ALL_SCOPES } from '../../scope-information';
import type { Scope } from '../../types';
import { pick } from './scope-filters';

/**
 * The instance owner and admin hold every scope. In community n8n the two are
 * behaviourally equivalent at the scope level — the owner is simply the single,
 * undeletable account — so both map to the full catalog.
 */
export const GLOBAL_OWNER_SCOPES: Scope[] = [...ALL_SCOPES];

export const GLOBAL_ADMIN_SCOPES: Scope[] = [...ALL_SCOPES];

/**
 * A member self-serves: manage tags/annotations, see other users (to share
 * with), read shared variables, and use chat. Members do NOT hold global
 * workflow/credential or user-management scopes — they reach their own
 * resources through their personal project's scopes.
 */
export const GLOBAL_MEMBER_SCOPES: Scope[] = [
	...pick(['tag', 'annotationTag'], ['create', 'read', 'update', 'delete', 'list']),
	// Only GLOBAL variables: project-variable visibility comes from project
	// roles, so members never see variables of projects they are not in.
	...pick(['variable'], ['read', 'list']),
	...pick(['user'], ['list']),
	...pick(['chatHub'], ['message']),
	...pick(['banner'], ['dismiss']),
];

/** A chat-only user can converse with chat-enabled workflows and nothing else. */
export const GLOBAL_CHAT_USER_SCOPES: Scope[] = [
	...pick(['chatHub'], ['message']),
	...pick(['banner'], ['dismiss']),
];
