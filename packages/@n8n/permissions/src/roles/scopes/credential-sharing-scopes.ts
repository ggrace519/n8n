import type { Scope } from '../../types';
import { pick } from './scope-filters';

/**
 * Scopes a credential *owner* retains on a shared credential. Acts as the mask
 * that lets ownership-level operations (share, move, end-user management) survive
 * onto the credential resource.
 */
export const CREDENTIALS_SHARING_OWNER_SCOPES: Scope[] = pick(
	['credential'],
	['read', 'update', 'delete', 'move', 'share', 'unshare', 'createEndUser', 'connect'],
);

/** Scopes a credential *user* (sharee) has — read/use only, no management. */
export const CREDENTIALS_SHARING_USER_SCOPES: Scope[] = pick(['credential'], ['read', 'connect']);
