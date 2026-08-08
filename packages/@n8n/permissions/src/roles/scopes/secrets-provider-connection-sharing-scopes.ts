import type { Scope } from '../../types';
import { pick } from './scope-filters';

/** Scopes a secrets-provider-connection *owner* retains on a shared connection. */
export const SECRETS_PROVIDER_CONNECTION_SHARING_OWNER_SCOPES: Scope[] = [
	...pick(['externalSecretsProvider'], ['read', 'update', 'delete', 'list', 'sync']),
	...pick(['externalSecret'], ['list']),
];

/** Scopes a secrets-provider-connection *user* (sharee) has — use only. */
export const SECRETS_PROVIDER_CONNECTION_SHARING_USER_SCOPES: Scope[] = pick(
	['externalSecret'],
	['list'],
);
