# E12b — dynamic-credentials external endpoints (clean-room contract)

Rebuilds the three externally facing dynamic-credential routes E12 left unbuilt,
plus the `oauth2-userinfo` resolver validation they depend on. **No `.ee` body was
read.** Every rule below is either *pinned* by a fair-code consumer or public
standard (source cited), or marked **chosen here** — a decision made in this
rebuild because no consumer pins it.

## Sources

- Frontend: `packages/frontend/editor-ui/src/features/ai/chatHub/chat.api.ts`
  (`fetchWorkflowExecutionStatus`, `authorizeDynamicCredential`, `revokeDynamicCredential`).
- E2E helper: `packages/testing/playwright/services/dynamic-credential-api-helper.ts`.
- E2E specs: `tests/e2e/dynamic-credentials/{execution-status,external-user-trigger,
  mcp-trigger-credential-gate,webhook-trigger-private-credential}.spec.ts`,
  capability env in `fixtures/capabilities.ts` (`dynamic-credentials`).
- Response schema: `@n8n/api-types` `WorkflowExecutionStatusSchema`.
- Existing fair-code: `oauth.service.ts` (`buildCsrfStateData`, `saveDynamicCredential`,
  `origin: 'dynamic-credential'` CSRF state), `oauth2-credential.controller.ts` callback,
  `StaticAuthService`, `DynamicCredentialsConfig`, `CredentialCheckService`,
  `McpServer.ts` / `MessageFormatter.ts` (consumers of `authorizationUrl`).
- Standards: OpenID Connect Discovery 1.0 (`userinfo_endpoint`), OpenID Connect Core
  1.0 §5.3 (UserInfo, `sub` claim), RFC 6750 (Bearer).

## Routes

| Route | Pinned by | Response |
|---|---|---|
| `GET /rest/workflows/:workflowId/execution-status` | chat.api, helper, execution-status spec | `WorkflowExecutionStatus` |
| `POST /rest/credentials/:credentialId/authorize?resolverId=` | chat.api, helper | provider authorization URL (string) |
| `GET /rest/credentials/:credentialId/authorize?token=` | helper `resolveProviderUrlFromAuthorizeLink` (302 + `Location`) | 302 to provider |
| `DELETE /rest/credentials/:credentialId/revoke?resolverId=` | chat.api | `{ success: true }` (**chosen here**) |

## Access (who may call)

- **Pinned:** external callers present the static token in `X-Authorization`
  (helper sends the raw token; capability sets `N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN`).
- **Pinned:** `authSource=cookie` means the caller's n8n session is the identity (chat.api).
- **Chosen here:** a request is admitted if it carries a valid n8n session **or** the
  configured static token, compared in constant time. With no token configured, only
  sessions are admitted (default-off for external callers). The `?token=` link route is
  admitted by its single-use link token alone.

## Identity (whose credential)

- **Pinned:** `Authorization: Bearer <token>` names an external user (helper comment
  "identifies the external user"); without it the session user is the identity.
- **Pinned:** resolver type `credential-resolver.oauth2-1.0` with config
  `{ metadataUri, validation: 'oauth2-userinfo' }` (execution-status spec).
- **Standard:** the subject of an `oauth2-userinfo` resolver is the `sub` claim returned
  by the provider's UserInfo endpoint for that Bearer token; the endpoint comes from the
  OIDC discovery document at `metadataUri`. A non-2xx answer or missing `sub` = not
  identified.
- **Chosen here (security):** a non-system resolver whose type/validation can't verify
  identity is **refused** — the raw Bearer string is never used as a storage key.
  Execution-time resolution uses the same rule, so data is keyed by stable `sub`, not a
  rotating access token.
- System resolver (`system-n8n`): subject = the session user (existing behaviour).

## execution-status

- **Pinned:** `{ workflowId, readyToExecute, credentials?: [{ credentialId, credentialName,
  credentialType, credentialStatus: 'missing'|'configured'|'resolver_missing',
  authorizationUrl?, revokeUrl? }] }`; a missing credential carries an `authorizationUrl`
  containing the credential id and `authorize`; `readyToExecute` is true iff all are
  configured (spec).
- Resolver per credential = credential → workflow setting → system (existing rule).
- **Chosen here:** absolute URLs are built from the instance's configured base URL
  (`urlBaseWebhook`/editor base), never from the request `Host` header.

## Authorization flow

- **Pinned:** the OAuth2 callback already stores per-subject tokens when the CSRF state
  has `origin: 'dynamic-credential'` + `credentialResolverId` + `authorizationHeader`
  (oauth.service / oauth2 controller). The authorize route builds that state for the
  chosen resolver and identity and returns the provider URL.
- **Chosen here:** `GET ?token=` links are opaque random tokens (not JWTs) mapped
  server-side to `{ credentialId, resolverId, authorizationHeader }`, single-use, 10-minute
  TTL, consumed atomically. The Bearer never appears in a URL.

## Revoke

- **Chosen here:** removes only the calling subject's entry for that credential +
  resolver; never another subject's.

## Security decisions (from review, all **chosen here**)

- **Identity source gate:** a non-system resolver only ever receives identities
  whose credential-context source is `external` (set by the authorize route and the
  `BearerTokenExtractor` webhook hook). An n8n session JWT (`manual-execution`) or an
  n8n-issued OAuth token (`n8n-oauth`) is never sent to a third-party UserInfo endpoint.
- **Browser binding:** flows started from a browser — the cookie `POST /authorize` and
  the `GET ?token=` link — are bound to that browser (`OAuthBrowserBindingService`)
  regardless of `N8N_OAUTH_BROWSER_BINDING`, so the consent must complete there.
- **Access checks:** a request carrying an n8n session needs `workflow:read` for status
  and `credential:connect` for authorize/revoke, even on the external (Bearer) path. A
  token-only external caller may only see workflows that use a non-system resolver.
- **Resolver binding:** a non-system resolver may connect a credential only if it is the
  credential's own resolver or one selected by a workflow that uses the credential.
- **SSRF / token exfiltration:** discovery and UserInfo requests go through the
  SSRF-guarded outbound client, must be `https`, never follow redirects, and the
  provider-advertised `userinfo_endpoint` must share the `metadataUri` origin (the
  caller's token is attached). Providers whose public UserInfo host differs from the
  discovery host must be configured with a discovery URL on that same host.
- **Single-use links:** consumed under a `LockService` lease (Redis under multi-main,
  key hashed), so two concurrent requests can't both use one. A link minted for an n8n
  user (gate, system resolver) only opens in that user's signed-in session, so a
  forwarded link can't land another person's provider tokens under them; a link for a
  non-n8n resolver must carry an `external` identity.
- **Webhook identity:** `BearerTokenExtractor` removes the `Authorization` header from
  the trigger item so the token is held only in the encrypted execution context.

### Residual risk (accepted, documented)

An external flow started by an **API client** (`POST /authorize` with a Bearer and the
static token) returns a provider URL that is not bound to any browser. Whoever holds
the static token and a valid IdP account could send that URL to someone else and have
their provider account linked under the sender's subject. Mitigations: the static
token is a partner secret and admits no one when unset; gate-issued links are bound on
open. Closing it fully needs the consenting provider account tied to the IdP subject,
which no consumer pins.

## Not covered

CORS behaviour beyond the existing `DynamicCredentialsConfig` fields; non-OAuth2
credential types on these routes (authorize answers 400).
