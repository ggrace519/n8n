/**
 * The system-managed resolver seeded on module init. It maps an n8n identity
 * (auth cookie or instance-issued OAuth token) to an n8n user and stores that
 * user's credential data in `dynamic_credential_user_entry`.
 *
 * The id is a stable well-known value shared with the frontend
 * (`@n8n/api-types` `SYSTEM_RESOLVER_ID`) — never regenerate it.
 */
export const SYSTEM_RESOLVER_ID = 'system-n8n';

export const SYSTEM_RESOLVER_NAME = 'n8n';

export const SYSTEM_RESOLVER_TYPE = 'n8n';
