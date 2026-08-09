export const OIDC_PREFERENCES_DB_KEY = 'features.oidc';
export const OIDC_LOGIN_ENABLED = 'sso.oidc.loginEnabled';
export const OIDC_CLIENT_SECRET_REDACTED_VALUE =
	'__n8n_CLIENT_SECRET_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6';

/**
 * Cookie holding the encrypted OIDC ID token of the current session. Its
 * presence marks the session as OIDC-established and provides the
 * `id_token_hint` required for OIDC RP-Initiated Logout.
 */
export const OIDC_ID_TOKEN_COOKIE_NAME = 'n8n-oidc-id-token';

/**
 * Browsers reject cookies above ~4096 bytes (name + value + attributes),
 * so leave a safety margin. Oversized ID tokens simply skip the cookie and
 * sign-out degrades to a local (n8n-only) logout.
 */
export const OIDC_ID_TOKEN_COOKIE_MAX_BYTES = 3800;

/** Cookie holding the `state` value of an in-flight authorization request. */
export const OIDC_STATE_COOKIE_NAME = 'n8n-oidc-state';

/** Cookie holding the `nonce` value of an in-flight authorization request. */
export const OIDC_NONCE_COOKIE_NAME = 'n8n-oidc-nonce';

/** Cookie holding the PKCE code verifier of an in-flight authorization request. */
export const OIDC_PKCE_COOKIE_NAME = 'n8n-oidc-pkce';

/** How long the state/nonce/PKCE cookies of an authorization request stay valid. */
export const OIDC_FLOW_COOKIE_MAX_AGE_MS = 15 * 60 * 1000;
