# Clean-room SAML and OIDC backend rebuild contract

Audit basis: surviving fair-code at commit `65512b964a54bff69e5dd696cee8adfd28bb4564`, equal to `origin/master` on 2026-08-09. I did not inspect git history, upstream n8n, deleted blobs, or any Enterprise implementation.

Evidence labels used below:

- **Hard pin** — directly required by a surviving test, DTO, consumer, or executable code.
- **Structural inference** — necessary to connect surviving fair-code, but the precise implementation is absent.
- **Open** — surviving code does not choose one behavior safely.

Verification:

- SAML validator and OIDC result-view tests: 11/11 passed.
- SAML/OIDC DTO tests: 17/17 passed.
- Working tree remained clean.
- The integration suites cannot currently run because they import the very missing backends—and some still import a separate missing `modules/provisioning.ee` implementation.

## 1. Module file maps and required exports

### SAML

| File | Status | Required exports/role |
|---|---|---|
| `sso-saml.module.ts` | Survives | `SamlModule`; backend module `sso-saml`, `licenseFlag: 'feat:saml'`, main instances only. Dynamically imports controller and `SamlService`, then calls `init()`. |
| `saml.service.ee.ts` | Missing | Named `SamlService` class registered with DI. Required public surface below. |
| `saml.controller.ee.ts` | Missing | Decorated controller imported for registration side effects. No consumer requires a named export, but convention implies `SamlController`. |
| `service-provider.ee.ts` | Missing | Must export `getServiceProviderEntityId`, `getServiceProviderReturnUrl`, and `getServiceProviderConfigTestReturnUrl`. Additional SP factory exports are structurally necessary but not named by surviving consumers. |
| `constants.ts` | Survives | `SAML_PREFERENCES_DB_KEY`, `SAML_LOGIN_LABEL`, `SAML_LOGIN_ENABLED`. |
| `saml-helpers.ts` | Survives | Login toggle/label, user creation/update, assertion mapping, connection-test detection/token extraction. |
| `saml-validator.ts` | Survives | `SamlValidator`. |
| `types.ts` | Survives | `SamlLoginBinding`, `SamlAttributeMapping`, `SamlUserAttributes`. |
| `middleware/saml-enabled-middleware.ts` | Survives | `samlLicensedMiddleware`, `samlLicensedAndEnabledMiddleware`. |
| `errors/invalid-saml-metadata*.ts` | Survives | `InvalidSamlMetadataError`, `InvalidSamlMetadataUrlError`. |
| `views/init-sso-post.ts` | Survives | `getInitSSOFormView(PostBindingContext)`. |
| `schema/*.xsd.ts` | Survives | Each exports `xmlFileInfo`; complete SAML protocol/assertion/metadata, XMLDSig, XML Encryption, XML base schema, and WS-Federation dependency set. |
| `__tests__/*` | Survives | Mapping, validation, signing fixtures and schema behavior. |

The complete surviving SAML directory comprises 25 files and 5,306 lines. The schema files are:

- `metadata-exchange.xsd.ts`
- `oasis-200401-wss-wssecurity-secext-1.0.xsd.ts`
- `oasis-200401-wss-wssecurity-utility-1.0.xsd.ts`
- `saml-schema-assertion-2.0.xsd.ts`
- `saml-schema-metadata-2.0.xsd.ts`
- `saml-schema-protocol-2.0.xsd.ts`
- `ws-addr.xsd.ts`
- `ws-authorization.xsd.ts`
- `ws-federation.xsd.ts`
- `ws-securitypolicy-1.2.xsd.ts`
- `xenc-schema.xsd.ts`
- `xml.xsd.ts`
- `xmldsig-core-schema.xsd.ts`

Primary sources: [SAML module](</home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-saml/sso-saml.module.ts>), [helpers](</home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-saml/saml-helpers.ts>), [validator](</home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-saml/saml-validator.ts>).

### Required `SamlService` surface

The surviving consumers/tests require at least:

```ts
class SamlService {
  init(): Promise<void>;

  readonly samlPreferences: SamlPreferences;

  setSamlPreferences(
    preferences: Partial<SamlPreferences>,
  ): Promise<unknown>;

  loadFromDbAndApplySamlPreferences(
    applyLoginState: boolean,
  ): Promise<SamlPreferences | undefined>;

  reset(): Promise<void>;

  fetchMetadataFromUrl(url: string): Promise<string>;

  consumePendingTestConfig(
    testId: string,
  ): Promise<unknown | undefined> | unknown | undefined;

  getAttributesFromLoginResponse(
    request: express.Request,
    binding: 'redirect' | 'post',
  ): Promise<{
    mapped: SamlUserAttributes;
    raw: Record<string, unknown>;
  }>;

  handleSamlLogin(
    request: express.Request,
    binding: 'redirect' | 'post',
  ): Promise<{
    attributes: SamlUserAttributes;
    authenticatedUser?: User;
  }>;
}
```

Tests additionally pin a private/internal `getDecryptedSigningPrivateKey(): Promise<string | undefined>` and an internal `_samlPreferences` state slot. Those names need not remain public, but the observable behavior must remain.

### OIDC

| File | Status | Required exports/role |
|---|---|---|
| `sso-oidc.module.ts` | Survives | `OidcModule`; backend module `sso-oidc`, `licenseFlag: 'feat:oidc'`, main instances only. Imports controller/service and calls `init()`. |
| `oidc.service.ee.ts` | Missing | Named DI service `OidcService`; required surface below. |
| `oidc.controller.ee.ts` | Missing | Decorated controller imported for registration side effects; convention implies `OidcController`. |
| `constants.ts` | Survives | Preference key, login key, secret sentinel, ID-token cookie name/size. |
| `views/oidc-test-result.ts` | Survives | `renderOidcTestSuccess`, `renderOidcTestFailure`. |
| `__tests__/oidc-test-result.test.ts` | Survives | Exact output and HTML-escaping contract. |

Primary sources: [OIDC module](</home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-oidc/sso-oidc.module.ts>), [constants](</home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-oidc/constants.ts>), [connection-test view](</home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-oidc/views/oidc-test-result.ts>).

### Required `OidcService` surface

Hard-pinned service methods:

```ts
class OidcService {
  init(): Promise<void>;

  loadConfig(includeSecret?: boolean): Promise<{
    clientId: string;
    clientSecret: string;
    discoveryEndpoint: URL;
    loginEnabled: boolean;
    prompt: OidcPrompt;
    authenticationContextClassReference: string[];
    additionalScopes: string;
    emailVerifiedRequired?: boolean;
    rpInitiatedLogoutEnabled: boolean;
  }>;

  updateConfig(config: OidcConfigDto): Promise<unknown>;
}
```

`loadConfig(true)` must return the decrypted client secret. The normal call must be safe for UI/API return and result in the redaction sentinel being exposed instead of plaintext.

The missing controller also forces service operations for discovery, authorization URL creation, callback/token processing, UserInfo, connection testing and logout, but no surviving consumer pins their method names.

## 2. `SamlService` and service-provider contract

### Preference defaults and validation

The DTO supplies these defaults:

```ts
{
  ignoreSSL: false,
  loginBinding: 'redirect',
  authnRequestsSigned: false,
  wantAssertionsSigned: true,
  wantMessageSigned: true,
  acsBinding: 'post',
  signatureConfig: {
    prefix: 'ds',
    location: {
      reference: '/samlp:Response/saml:Issuer',
      action: 'after',
    },
  },
  relayState: '',
}
```

The mapping consists of required SAML attribute names for `email`, `firstName`, `lastName`, and `userPrincipalName`, plus optional `n8nInstanceRole` and `n8nProjectRoles`.

Hard validator behavior:

1. Lazily load `samlify`, `xmllint-wasm`, and every embedded schema.
2. Validate IdP metadata against the SAML metadata schema with all referenced SAML/XML/WS-Fed schemas preloaded.
3. Construct the IdP through:

   ```ts
   samlify.IdentityProvider({ metadata })
   ```

4. Require an HTTP-Redirect SSO endpoint via:

   ```ts
   idp.entityMeta.getSingleSignOnService(
     samlify.Constants.wording.binding.redirect,
   )
   ```

5. If that call does not return a string, throw:

   > `Invalid SAML metadata: only SAML redirect binding is supported.`

6. Validate decoded SAML responses against `saml-schema-protocol-2.0`.

The validator tests hard-pin rejection of malformed metadata, missing SSO service, invalid certificates and expired responses; valid responses pass. WS-Federation schemas are deliberately present so metadata containing Azure/ADFS-style WS-Fed extensions can still validate.

Source: [SAML DTO](</home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/saml/saml-preferences.dto.ts>), [validator tests](</home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-saml/__tests__/saml-validator.test.ts>).

### Metadata URL handling

Hard pins from the real-socket integration tests:

- `fetchMetadataFromUrl(url)` performs an actual HTTP fetch and returns the XML body.
- Saving preferences with `metadata: ''` and a `metadataUrl` fetches the URL and persists both the URL and fetched XML.
- Invalid/non-metadata responses reject as `BadRequestError`.
- The error class format is:

  > `Failed to produce valid SAML metadata from ${url}`

`ignoreSSL` is part of the configuration and must survive round trips. Its precise HTTP-agent implementation is not pinned. SSRF policy, redirect limits, timeouts and maximum metadata size are also open and should be implemented through the repository’s outbound HTTP abstraction.

### Service-provider URLs and metadata

Hard-pinned exported URLs:

```text
entityID   = <instance-base>/<rest-endpoint>/sso/saml/metadata
returnUrl  = <instance-base>/<rest-endpoint>/sso/saml/acs
testReturn = <instance-base>/config/test/return
```

Tests require `entityID` to contain `/rest/sso/saml/metadata` and `returnUrl` to contain `/rest/sso/saml/acs`. The base should come from `UrlService.getInstanceBaseUrl()` and the configured REST endpoint.

The SP metadata must reflect:

- `entityID`
- ACS location and configured `acsBinding`
- `authnRequestsSigned`
- `wantAssertionsSigned`
- `wantMessageSigned`
- `signatureConfig`
- signing certificate when configured

Structural library adapter:

```ts
const sp = samlify.ServiceProvider({
  entityID: getServiceProviderEntityId(),
  assertionConsumerService: [{
    Binding: /* SAML binding URN for prefs.acsBinding */,
    Location: getServiceProviderReturnUrl(),
  }],
  authnRequestsSigned: prefs.authnRequestsSigned,
  wantAssertionsSigned: prefs.wantAssertionsSigned,
  wantMessageSigned: prefs.wantMessageSigned,
  privateKey: decryptedSigningPrivateKey,
  signingCert: prefs.signingCertificate,
  signatureConfig: prefs.signatureConfig,
});

const metadata = sp.getMetadata();
```

The exact exported SP factory name, NameID formats, clock drift allowance and request-signature algorithm are open.

### Authentication request generation

The installed API and surviving view require two output modes:

```ts
sp.createLoginRequest(idp, binding, { relayState })
```

- Redirect binding: return the IdP redirect URL.
- POST binding: pass `PostBindingContext` to `getInitSSOFormView`.
- RelayState must be supplied per request. The installed samlify type explicitly marks entity-level `relayState` deprecated because concurrent requests can otherwise leak RelayState across users.
- The POST view submits a hidden SAML request input and optional `RelayState`, then automatically submits the form.

The service must not treat `SamlPreferences.relayState` as mutable shared request state.

### Connection-test flow

Hard-pinned flow:

1. `POST /sso/saml/config/test` accepts unsaved partial preferences containing XML or metadata URL.
2. It creates an opaque hexadecimal test ID.
3. It temporarily retains the test preferences without saving them as active configuration.
4. RelayState points to `/config/test/return?t=<hex>`.
5. ACS identifies a test through `RelayState.startsWith(getServiceProviderConfigTestReturnUrl())`.
6. `extractTestIdFromRelayState()` parses the absolute URL and extracts `t`.
7. ACS consumes the pending configuration exactly once.
8. Test callbacks always render a result page with HTTP 200, even when assertion parsing fails.
9. Failure output contains:

   > `SAML Connection Test failed`

10. It must not fall through to the normal-login error:

   > `No IdP metadata configured`

Successful output exposes mapped email/name/UPN plus HTML-escaped raw attributes for role-mapping debugging. The default failure message is:

> `A common issue could be that no email attribute is set`

Source: [SAML round-trip spec](</home/ggrace/linux-coding/n8n/packages/cli/test/integration/saml/saml.api.test.ts>), [result templates](</home/ggrace/linux-coding/n8n/packages/cli/templates/saml-connection-test-success.handlebars>).

### Assertion consumption and attribute mapping

The installed parser shape is:

```ts
const flowResult = await sp.parseLoginResponse(idp, binding, request);
```

Hard mapping behavior from `getMappedSamlAttributesFromFlowResult`:

```ts
{
  attributes: {
    email: raw[mapping.email],
    firstName: raw[mapping.firstName],
    lastName: raw[mapping.lastName],
    userPrincipalName: raw[mapping.userPrincipalName],
    n8nInstanceRole?: raw[configuredJitInstanceRoleClaim],
    n8nProjectRoles?: string[],
  },
  missingAttributes: string[],
  rawAttributes: raw,
}
```

Rules:

- Required missing-attribute order: email, UPN, first name, last name.
- Instance role is accepted only when the configured claim value is a string.
- A single project-role string becomes a one-element array.
- A project-role array is retained.
- All raw assertion attributes are preserved for expression mapping.
- `handleSamlLogin()` lowercases email for validation, but the returned `attributes.email` preserves the IdP’s original casing.
- Invalid emails throw `BadRequestError('Invalid email format')`.

### User onboarding and updates

Hard-pinned new-user behavior:

- Lowercase stored email.
- Store first/last name.
- Generate an unknown 18-character random password and hash it.
- Initial role is `global:member`, subject to subsequent provisioning.
- Create the user and personal project atomically.
- Create an `AuthIdentity`:

  ```ts
  {
    providerType: 'saml',
    providerId: attributes.userPrincipalName,
    userId: user.id,
  }
  ```

Hard-pinned existing-user behavior:

- Attach a SAML identity if missing, otherwise update its `providerId`.
- Update first and last name.
- Do not update email in `updateUserFromSamlAttributes`.
- Use `UserRepository.save`, not `update`, because entity subscribers need the full user.
- Reload the user with `role`.
- Errors are exactly:

  - `Email is required to update user`
  - `User not found`
  - `Could not update User`
  - `Failed to fetch user!`

Expression-provisioning specs require role resolution before committing an account mutation:

- Matching instance rule can assign `global:admin`.
- Matching project rule can assign `project:editor`.
- When fallback is `BLOCK_ACCESS_ASSIGNMENT`, reject with `ForbiddenError`.
- A rejected new login creates no account.
- A rejected existing login must not disable or modify the existing account.
- `$claims` receives the raw SAML attributes.
- Provider discriminator must be `saml`.

The direct-claim role algorithm, invalid role handling and project-membership reconciliation are delegated to the provisioning rebuild and are not pinned inside `SamlService`.

## 3. `OidcService` contract

OIDC has a strong configuration/discovery contract but a substantially weaker runtime-login contract.

### Configuration and discovery

Hard defaults:

```ts
{
  clientId: string,
  clientSecret: string,
  discoveryEndpoint: URL,
  loginEnabled: false,
  prompt: 'select_account',
  authenticationContextClassReference: [],
  additionalScopes: '',
  emailVerifiedRequired: false, // normalized by public mapper
  rpInitiatedLogoutEnabled: false,
}
```

Allowed prompts:

```text
none | login | consent | select_account | create
```

`updateConfig()` must:

- Reject empty client ID/secret.
- Reject invalid discovery URLs.
- Preserve the stored secret when the submitted value is:

  ```text
  __n8n_CLIENT_SECRET_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6
  ```

- Validate the provider by executing discovery before accepting the write.
- Keep SAML/OIDC/LDAP mutually exclusive. Enabling OIDC while SAML is active returns 400 with a message containing `saml`.
- Update `GlobalConfig.sso.oidc.loginEnabled` and the current authentication method consistently.
- Return/store `discoveryEndpoint` as a `URL` internally, stringifying only at API boundaries.

Exact discovery call shape pinned by the real HTTP spec:

```ts
const configuration = await client.discovery(
  new URL(discoveryEndpoint),
  clientId,
  clientSecret,
  undefined,
  {
    execute: [client.allowInsecureRequests], // test-only for loopback HTTP
    [client.customFetch]: customFetch,
  },
);

configuration[client.customFetch] = customFetch;
```

The surviving test explicitly says the same fetch must carry through to token exchange and UserInfo. Production should construct this fetch through `OutboundHttp`; `ssrf: 'disabled'` appears only in the loopback test and is not a production requirement.

Source: [discovery integration spec](</home/ggrace/linux-coding/n8n/packages/cli/test/integration/oidc/oidc-discovery-http.test.ts>).

### Authorization URL

The controller contract requires an operation returning a URL for:

- Normal login: `GET /sso/oidc/login`.
- Connection test: `POST /sso/oidc/config/test` → `{ url }`.

The installed API supports:

```ts
const verifier = client.randomPKCECodeVerifier();
const challenge = await client.calculatePKCECodeChallenge(verifier);

const url = client.buildAuthorizationUrl(configuration, {
  redirect_uri: callbackUrl,
  scope,
  prompt,
  acr_values,
  state,
  nonce,
  code_challenge: challenge,
  code_challenge_method: 'S256',
});
```

Hard pins:

- Callback URL is `<instance-base>/<rest-endpoint>/sso/oidc/callback`.
- State cookie name: `n8n-oidc-state`.
- Nonce cookie name: `n8n-oidc-nonce`.
- Configuration supports prompt, ACR array and space-separated additional scopes.
- The provisioning configuration defines an additional scope name, default `n8n`.

Open:

- PKCE use is strongly appropriate and supported, but no surviving OIDC code or cookie pins storage of the verifier.
- Base scopes are not stated. `openid email profile` is the likely minimum but is not a surviving fact.
- State/nonce lifetime, encoding, encryption, SameSite and Secure attributes are absent.
- How connection-test state is distinguished from normal login is absent.

### Callback/token exchange

The installed API shape is:

```ts
const tokens = await client.authorizationCodeGrant(
  configuration,
  currentCallbackUrl,
  {
    expectedState,
    expectedNonce,
    pkceCodeVerifier,
    idTokenExpected: true,
  },
);

const claims = tokens.claims();

const userInfo = await client.fetchUserInfo(
  configuration,
  tokens.access_token,
  claims.sub,
);
```

Hard pins:

- Callback path exists in frontend settings.
- Discovery metadata must support authorization, token, UserInfo and JWKS endpoints.
- Connection-test output receives both ID-token claims and UserInfo.
- UserInfo fields displayed as the canonical user attributes are:

  - `email`
  - `given_name`
  - `family_name`
  - `sub`

- Full ID-token claims and UserInfo are retained separately for role-mapping diagnostics.
- All test-result values and JSON are HTML-escaped.
- Success/failure messages are exactly:

  - `OIDC Connection Test was successful`
  - `OIDC Connection Test failed`

Open:

- Whether actual login always calls UserInfo or may fall back to ID-token claims.
- The exact error when `email_verified` is missing/false while `emailVerifiedRequired` is true.
- Callback behavior for missing `sub`, email, or names.
- State/nonce/PKCE cleanup and replay behavior.
- Whether callback failures return HTML, redirect with an error, or JSON outside connection-test mode.

### User provisioning

The surviving contract only pins the inputs, not the algorithm:

- Identity data is expected from UserInfo.
- Expression context is intended to expose:

  ```ts
  {
    $claims,
    $oidc: {
      idToken: claims,
      userInfo,
    },
    $provider: 'oidc',
  }
  ```

- `AuthIdentity.providerType` supports `oidc`.
- The natural stable identity is `sub`, but no surviving OIDC helper or test proves whether `providerId` is plain `sub` or qualified with issuer.
- The SAML expression-mapping events explicitly admit provider `oidc`.

A safe rebuild needs an explicit decision and tests for:

- issuer-qualified subject versus plain subject;
- lookup precedence: OIDC identity, then email, then create;
- account conversion/identity attachment;
- name updates;
- JIT-disabled behavior;
- blocked-role behavior before writes;
- direct-claim and expression-based role provisioning;
- owner protection;
- user-quota enforcement.

Normal successful callbacks should structurally reuse:

```ts
authService.issueCookie(res, user, false, req.browserId);
eventService.emit('user-logged-in', {
  user,
  authenticationMethod: 'oidc',
});
```

That is consistent with every surviving authentication flow and the audit contract, but no OIDC callback test directly pins it.

### RP-initiated logout

Hard pins:

- Endpoint returns `{ redirectUrl: string | null }`.
- Local n8n logout always occurs, even when no provider redirect is possible.
- ID-token cookie name is `n8n-oidc-id-token`.
- That cookie must hold an encrypted ID token.
- Maximum stored size is 3,800 bytes.
- Oversized tokens skip the cookie; logout degrades to local-only.
- RP logout is configurable with `rpInitiatedLogoutEnabled`.

The installed provider redirect shape is:

```ts
client.buildEndSessionUrl(configuration, {
  post_logout_redirect_uri,
  id_token_hint: decryptedIdToken,
});
```

The endpoint must invalidate the current n8n JWT and clear both the n8n auth cookie and OIDC ID-token cookie before returning. The precise post-logout redirect URI and ID-token cookie options are open.

## 4. Controller routes

Paths below include the normal `/rest` endpoint prefix.

### SAML internal routes

| Method/path | Auth/scope | License gate | Input | Pinned responses |
|---|---|---|---|---|
| `GET /rest/sso/saml/metadata` | Public | SAML licensed | None | 200. Intended body is generated SP XML; test pins access/status but not exact content type/body. |
| `GET /rest/sso/saml/config` | Owner allowed; member 403; authless 401 | SAML licensed | None | 200 `{data: ...}`. Includes `entityID`/`returnUrl`; private key redacted. Internal certificate is plaintext. |
| `POST /rest/sso/saml/config` | Owner allowed; member 403; authless 401 | SAML licensed | `Partial<SamlPreferences>` | 200; invalid binding/config 400. May enable/disable SAML and update active auth method. |
| `POST /rest/sso/saml/config/toggle` | Owner allowed; member 403; authless 401 | SAML licensed | `{loginEnabled:boolean}` | 200; missing body 400; conflicting active auth method 400. |
| `POST /rest/sso/saml/config/test` | Owner allowed; member 403; authless 401 | SAML licensed, login need not be enabled | Partial metadata config | 200 with IdP URL string. |
| `GET /rest/sso/saml/initsso?redirect=...` | Public | Licensed and enabled | `redirect` query | 200 login-init value. Redirect-binding URL vs POST-form behavior is inferred from the surviving view. |
| `GET /rest/sso/saml/acs` | Public | Licensed and enabled | Redirect-binding SAML response/query | Missing payload: 401 text containing `SAML Authentication failed`. |
| `POST /rest/sso/saml/acs` | Public | Licensed and enabled | Form body containing `SAMLResponse`, optional `RelayState` | Normal failure: 401 with `SAML Authentication failed`; connection test: always 200 HTML. |

Internal decorator names are missing. The SAML access tests hard-pin behavior equivalent to owner-only administration, but do not prove whether the controller used `@GlobalScope('saml:manage')`, an owner-role decorator, or middleware.

The surviving `SamlAcsDto` only declares `RelayState`; it omits `SAMLResponse`. That request typing gap must be fixed or handled directly from the Express request.

SAML middleware failure is exactly:

```json
{"status":"error","message":"Unauthorized"}
```

with HTTP 403.

### OIDC internal routes

| Method/path | Auth/scope | Gate | Input/output |
|---|---|---|---|
| `GET /rest/sso/oidc/config` | Administrative authentication required; precise scope unpinned | `feat:oidc` | 200 `{data: OidcConfigDto}` with redacted secret. |
| `POST /rest/sso/oidc/config` | Administrative authentication required; precise scope unpinned | `feat:oidc` | Full `OidcConfigDto`; 200 redacted config; invalid/discovery/conflict 400. |
| `POST /rest/sso/oidc/config/test` | Administrative authentication required; precise scope unpinned | `feat:oidc` | No body; 200 `{data:{url:string}}`. |
| `GET /rest/sso/oidc/login` | Public | Licensed and OIDC active | 200 authorization URL string. |
| `GET /rest/sso/oidc/callback` | Public | Licensed; callback must still work for a pending test | Query authorization response | Normal login status/redirect unpinned; connection test returns 200 success/failure HTML. |
| `POST /rest/sso/oidc/logout` | Authenticated | Module/license availability | No body; 200 `{data:{redirectUrl:string|null}}`; local session always ended. |

No OIDC permission matrix survives. The frontend SSO settings page is currently routed with `saml:manage`, while the public OIDC API uses `oidc:manage`; the internal controller must not guess silently between those two.

### Public API v1

| Method/path | Auth/scope | License | Body | Statuses |
|---|---|---|---|---|
| `GET /api/v1/settings/sso/saml` | API key + `saml:manage`, with global-scope fallback | `feat:saml` | None | 200, 401, 403 |
| `PUT /api/v1/settings/sso/saml` | API key + `saml:manage` | `feat:saml` | Full `UpdateSamlConfigurationDto` | 200, 400, 401, 403, 409 |
| `GET /api/v1/settings/sso/oidc` | API key + `oidc:manage`, with global-scope fallback | `feat:oidc` | None | 200, 401, 403 |
| `PUT /api/v1/settings/sso/oidc` | API key + `oidc:manage` | `feat:oidc` | Full `UpdateOidcConfigurationDto` | 200, 400, 401, 403, 409 |

Public writes parse DTOs and return the first Zod error, falling back to:

> `Invalid request body`

Declaratively managed writes return 409:

> `SSO configuration is managed declaratively and cannot be modified through the API`

SAML public GET redacts metadata, signing key and certificate. OIDC redacts the client secret. GET output can be sent back as PUT input without erasing secrets.

Sources: [SAML public handler](</home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/handlers/sso-saml/sso-saml.handler.ts>), [OIDC public handler](</home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/handlers/sso-oidc/sso-oidc.handler.ts>), [frontend REST client](</home/ggrace/linux-coding/n8n/packages/frontend/@n8n/rest-api-client/src/api/sso.ts>).

## 5. Configuration persistence and encryption

| Concern | SAML | OIDC |
|---|---|---|
| Settings key | `features.saml` | `features.oidc` |
| Stored format | JSON `SamlPreferences` | JSON OIDC configuration |
| Startup row | `loadOnStartup: true` | `loadOnStartup: true` |
| Primary secret | Signing private key | Client secret |
| At-rest requirement | Encrypted/decryptable; exact Cipher API not pinned | `Cipher.encryptV2()` hard-pinned by env loader; `loadConfig(true)` decrypts |
| Redaction | Internal private key uses `CREDENTIAL_BLANKING_VALUE`; public API also redacts metadata/cert | Dedicated exact sentinel |
| Public material | Internal certificate plaintext; public API deliberately redacts it | N/A |
| Disable row from env | `{"loginEnabled":false}` | `{"loginEnabled":false}` |

SAML behavior:

- Empty private key/certificate clears them.
- `CREDENTIAL_BLANKING_VALUE` preserves the private key.
- RSA and EC keys must both be accepted.
- Key/certificate mismatch returns 400 containing `do not match`.
- Invalid key: `Invalid signing private key format`.
- Invalid certificate: `Invalid signing certificate format`.
- Signed requests without both values: `Both signingPrivateKey and signingCertificate are required`.
- When `N8N_ENV_FEAT_SIGNED_SAML_REQUESTS` is not enabled, supplying signing material returns 400 containing `SAML request signing is not enabled`.

OIDC behavior:

- Client secret must never be returned in plaintext.
- `loadConfig(true)` is the explicit privileged plaintext path.
- Env-managed config encrypts the client secret before writing the row.
- Env-managed configuration currently has no `emailVerifiedRequired` variable, so the service must merge the missing value to false.

Declarative configuration:

- `N8N_SSO_MANAGED_BY_ENV=true` locks both public API writes.
- Both protocols cannot be enabled together.
- SAML requires metadata XML or metadata URL.
- OIDC requires client ID, client secret and valid discovery URL.
- OIDC ACR is comma-split, trimmed and empty values removed.
- Additional scopes remain a space-separated string.
- Load order is SAML → OIDC → provisioning → authentication-method sync.

Authentication method is persisted separately under:

```text
userManagement.authenticationMethod
```

with `loadOnStartup: true`. Enabling a protocol is only allowed from `email` or itself; it must not silently displace LDAP or the other SSO protocol.

There is one configuration drift defect: the legacy Convict schema only lists `email | ldap | saml`, while the shared type and SSO loader use `oidc`. `config.set()` does not validate immediately today, so this is latent rather than an observed runtime failure, but the schema must be reconciled.

Sources: [SSO helpers](</home/ggrace/linux-coding/n8n/packages/cli/src/sso/sso-helpers.ts>), [OIDC env loader](</home/ggrace/linux-coding/n8n/packages/cli/src/instance-settings-loader/loaders/sso/oidc.instance-settings-loader.ts>), [SAML env loader](</home/ggrace/linux-coding/n8n/packages/cli/src/instance-settings-loader/loaders/sso/saml.instance-settings-loader.ts>).

## 6. Events and telemetry

### Configuration telemetry

Frontend SAML save:

```ts
telemetry.track('User updated single sign on settings', {
  instance_id,
  authentication_method: 'saml',
  identity_provider: metadataUrl ? 'metadata' : 'xml',
  is_active: loginEnabled,
});
```

Frontend OIDC save:

```ts
telemetry.track('User updated single sign on settings', {
  instance_id,
  authentication_method: 'oidc',
  discovery_endpoint: discoveryEndpoint,
  is_active: loginEnabled,
});
```

No surviving backend SAML/OIDC configuration event is pinned.

### Login and audit

The standard successful-login event is:

```ts
eventService.emit('user-logged-in', {
  user,
  authenticationMethod: 'saml' | 'oidc',
});
```

It feeds audit event:

```text
n8n.audit.user.login.success
```

SAML/OIDC callback emission is structurally required for parity, but no callback test directly asserts it.

### Provisioning events

Surviving event contracts:

```ts
'sso-user-project-access-updated': {
  projectsRemoved: number;
  projectsAdded: number;
  userId: string;
}

'sso-user-instance-role-updated': {
  role: string;
  userId: string;
}

'expression-mapping-roles-resolved': {
  userId: string;
  userEmail: string;
  provider: 'oidc' | 'saml' | 'ldap';
  instanceRole: { ... };
  projectRoles: Array<{ ... }>;
  removedProjectIds: string[];
}
```

The expression result becomes audit event:

```text
n8n.audit.role-mapping.roles-resolved
```

### Scaling reload commands

The PubSub map reserves:

```text
reload-saml-config
reload-oidc-config
reload-sso-provisioning-configuration
```

No surviving SAML/OIDC service subscribes to or publishes the first two, so the reload topology is under-pinned.

Telemetry startup payloads expose both licensed features, but the legacy instance telemetry has `saml_enabled` and no equivalent `oidc_enabled`. That asymmetry should be decided explicitly.

## 7. Library versions and exact API notes

Pinned dependencies in [packages/cli/package.json](</home/ggrace/linux-coding/n8n/packages/cli/package.json>):

```json
{
  "samlify": "2.13.0",
  "openid-client": "6.8.4"
}
```

Neither dependency is listed under `patchedDependencies`.

### Surviving samlify calls

These are the only production calls still in fair-code:

```ts
const samlify = await import('samlify');

const idp = samlify.IdentityProvider({ metadata });

idp.entityMeta.getSingleSignOnService(
  samlify.Constants.wording.binding.redirect,
);
```

Surviving type imports:

```ts
import type { IdentityProviderInstance } from 'samlify';
import type { FlowResult } from 'samlify/types/src/flow';
import type { PostBindingContext } from 'samlify/types/src/entity';
```

Installed 2.13.0 APIs that fit the missing adapter:

```ts
samlify.ServiceProvider(settings)
sp.getMetadata()
sp.createLoginRequest(idp, binding, { relayState })
sp.parseLoginResponse(idp, binding, request)
```

Important current signature:

```ts
createLoginRequest(
  idp,
  binding?,
  optionsOrCallback?: {
    relayState?: string;
    customTagReplacement?: ...;
    forceAuthn?: boolean;
    assertionConsumerServiceIndex?: number;
  },
)
```

RelayState belongs in this per-request options bag.

### Surviving openid-client call

The real-network spec pins:

```ts
client.discovery(
  new URL(discoveryUrl),
  clientId,
  clientSecret,
  undefined,
  {
    execute: [client.allowInsecureRequests],
    [client.customFetch]: customFetch,
  },
);

configuration[client.customFetch] = customFetch;
configuration.serverMetadata();
```

Installed 6.8.4 APIs available for the missing runtime:

```ts
client.randomPKCECodeVerifier(): string
client.calculatePKCECodeChallenge(verifier): Promise<string>
client.buildAuthorizationUrl(config, parameters): URL
client.authorizationCodeGrant(
  config,
  currentUrl,
  {
    expectedNonce?,
    expectedState?,
    idTokenExpected?,
    maxAge?,
    pkceCodeVerifier?,
  },
): Promise<TokenResponseWithHelpers>
client.fetchUserInfo(
  config,
  accessToken,
  expectedSubject,
): Promise<UserInfoResponse>
client.buildEndSessionUrl(config, parameters?): URL
```

These are installed library APIs, not proof that the purged implementation used every one.

## 8. Explicitly open or under-pinned areas

These must not be filled in by pretending the old implementation is known:

1. **OIDC identity key:** plain `sub` versus issuer-qualified subject.
2. **OIDC account resolution:** identity-first/email-first order, account conversion and collision behavior.
3. **OIDC callback response:** exact normal-login redirect, error page and status codes.
4. **OIDC claim precedence:** UserInfo versus ID-token fallback for email/names.
5. **`emailVerifiedRequired`:** exact source claim, accepted values and error text.
6. **PKCE:** supported and recommended by the installed client, but verifier persistence is absent.
7. **OIDC cookie policy:** lifetimes, encryption call, SameSite/Secure/path settings and cleanup.
8. **OIDC base scopes:** no surviving code pins `openid profile email`.
9. **OIDC connection-test marker:** no state format or single-use cache mechanism survives.
10. **OIDC logout redirect:** precise `post_logout_redirect_uri` and provider-error behavior.
11. **SAML SP factory exports:** only the three URL helpers are named by survivors.
12. **SAML metadata XML details:** NameID formats, clock drift, signing algorithm and optional metadata elements.
13. **SAML metadata fetching:** SSRF, timeout, redirects, response-size ceiling and exact `ignoreSSL` implementation.
14. **SAML normal RelayState:** validation and safe redirect destination handling are absent; the frontend accepts an arbitrary `redirect` query.
15. **SAML missing-attribute login error:** connection-test rendering is pinned, normal-login error text is not.
16. **JIT disabled behavior:** `N8N_SSO_JUST_IN_TIME_PROVISIONING` exists, but no surviving service logic uses it.
17. **Direct role claims:** extraction is pinned; validation/reconciliation semantics are in the absent provisioning layer.
18. **Internal controller scopes:** SAML access behavior is pinned, decorator name is not. OIDC internal authorization is barely tested.
19. **Scaling config propagation:** PubSub command names survive without publishers/subscribers.
20. **DTO gap:** `SamlAcsDto` omits `SAMLResponse`.
21. **Legacy auth schema drift:** Convict omits `oidc`.
22. **Provisioning dependency mismatch:** integration specs import missing `modules/provisioning.ee/...`; the surviving `modules/provisioning/ProvisioningService` lacks the `init()` and mutable `provisioningConfig` API expected by those specs. This blocks empirical execution of the SAML role-provisioning contract until reconciled.
23. **No redirect-style auth handler:** unlike LDAP, SAML/OIDC modules should not register password `@AuthHandler`s. Their controllers own browser redirects/callbacks; the current registry only supports password handlers.
24. **MFA semantics:** callbacks presumably issue a session without local MFA, but no surviving SSO spec defines interaction with enforced MFA.

The safest rebuild boundary is therefore: implement every hard pin above unchanged, use the current library APIs and shared auth/session primitives, and add new clean-room tests for each item in this open list before choosing its behavior.