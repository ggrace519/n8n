# Clean-room rebuild contract: external secrets

The surviving contract requires a dual-mode, license-gated backend module with:

- A provider-constructor catalog and runtime provider registry.
- A manager implementing the synchronous `ExternalSecretsProxy` interface.
- Legacy settings-row storage and new connection-entity storage.
- Five route groups exposing 25 tested endpoints.
- Six canonical provider type identifiers.
- Project-scoped access, transactional project-deletion cleanup, completions, lifecycle reload, telemetry/audit events, and credential-only `$secrets` resolution.

No purged implementation, Git history, other branches, or upstream source was used. The named 4,408-line acceptance corpus was read fully; the additional surviving 288-line expression integration spec was also included.

## 1. Required module file map and exports

The exact controller filenames are not pinned, but this is the minimum clean-room surface forced by surviving imports and behavior:

| Suggested clean path | Required export/responsibility | Evidence |
|---|---|---|
| `external-secrets.module.ts` | `ExternalSecretsModule`; `@BackendModule`, `init()`, `@OnShutdown() shutdown()`, pubsub reload registration, controller imports, proxy-manager wiring | [module spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.module.test.ts:21) |
| `external-secrets.config.ts` | `ExternalSecretsConfig` | [surviving config](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/external-secrets/external-secrets.config.ts:3) |
| `types.ts` | `SecretsProvider`, `SecretsProviderSettings<T>`, `ExternalSecretsSettings`, legacy/new state types | [provider fixtures](/home/ggrace/linux-coding/n8n/packages/cli/test/shared/external-secrets/utils.ts:4) |
| `external-secrets-providers.ts` | `ExternalSecretsProviders`: catalog `Record<string, new () => SecretsProvider>` | [provider fixture registry](/home/ggrace/linux-coding/n8n/packages/cli/test/shared/external-secrets/utils.ts:7) |
| `external-secrets-manager.ts` | `ExternalSecretsManager`; lifecycle, provider lookup, cache-facing secret access, `IExternalSecretsManager` implementation | [manager construction](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:64) |
| `external-secrets-provider-connection-manager.ts` | `ExternalSecretsProviderConnectionManager`; entity-backed connection construction/replacement | [required import](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:13) |
| `provider-registry.service.ts` | `ExternalSecretsProviderRegistry`; runtime instances keyed by expression-facing `providerKey`; must support `clear()` | [registry reset](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:68) |
| `provider-lifecycle.service.ts` | `ExternalSecretsProviderLifecycle`; init/connect/update/disconnect and state transitions | [required import](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:14) |
| `secrets-cache.service.ts` | `ExternalSecretsSecretsCache`; secret values/names refreshed after provider updates | [required import](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:16) |
| `settings-store.service.ts` | `ExternalSecretsSettingsStore`; encrypted `feature.externalSecrets` load/save/reload | [settings helpers](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:50) |
| `external-secrets.controller.ts` | Legacy `/external-secrets/**` routes | [legacy API spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:190) |
| `secret-providers-connections.controller.ts` | Global connection CRUD/test/reload | [connections spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-connections.api.test.ts:113) |
| `secret-providers-project.controller.ts` | Project-context connection routes | [project spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-project.api.test.ts:107) |
| `secret-providers-types.controller.ts` | Provider metadata routes | [types spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-types.api.test.ts:63) |
| `secret-providers-completions.controller.ts` | Global/project secret-name completions | [completions spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secrets-providers-completions.api.test.ts:124) |
| Connection service, name unpinned | Encryption, redaction, DTO-to-entity conversion, access rows, event emission, response shaping | Inferred from all connection specs |
| Provider implementation files | Constructors registered under the six canonical keys below | [provider enum](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/schemas/secrets-provider.schema.ts:10) |

Two distinct registries are required:

- `ExternalSecretsProviders` is the catalog of available provider constructors, indexed by provider **type**.
- `ExternalSecretsProviderRegistry` stores live instances indexed by connection **providerKey**. This distinction permits multiple AWS/Vault connections with different expression names.

All surviving test imports and the test-server endpoint loader must be migrated completely from `.ee` paths to the clean module. The test server currently imports the missing module at [test-server.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/shared/utils/test-server.ts:352).

### Configuration

The surviving config pins:

- `N8N_EXTERNAL_SECRETS_UPDATE_INTERVAL`, numeric seconds, default `300`.
- `N8N_EXTERNAL_SECRETS_FOR_PROJECTS`, default `false`.

See [external-secrets.config.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/external-secrets/external-secrets.config.ts:5).

The specs additionally access `externalSecretsMultipleConnections`, but the surviving config does not define it. This is a required compatibility field unless the specs are deliberately rewritten to remove the legacy mode distinction:

- [module spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.module.test.ts:60)
- [legacy API spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:139)

The frontend module-settings type expects:

```ts
{
  multipleConnections: boolean;
  forProjects: boolean;
  roleBasedAccess: boolean;
  systemRolesEnabled: boolean;
}
```

at [frontend-settings.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/frontend-settings.ts:364).

## 2. Provider contract

### Canonical identities

The public DTO enum allows exactly:

1. `awsSecretsManager`
2. `gcpSecretsManager`
3. `vault`
4. `azureKeyVault`
5. `infisical`
6. `onePassword`

This is pinned at [secrets-provider.schema.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/schemas/secrets-provider.schema.ts:10).

The provider catalog remains runtime-extensible in tests: `dummy`, `another_dummy`, and `mock_provider` are returned by the types API even though they are outside the public enum. Therefore controllers/services must not assume the constructor catalog itself is statically limited to the DTO enum.

### Base `SecretsProvider`

Every provider must expose:

```ts
abstract class SecretsProvider {
  name: string;
  displayName: string;
  icon: string; // fixtures imply fallback to name
  properties: INodeProperties[];
  state: SecretsProviderState;
  connectedAt: Date | string | null | false;

  abstract init(settings: SecretsProviderSettings<IDataObject>): Promise<void>;
  connect(): Promise<void>;              // inherited wrapper around doConnect()
  protected abstract doConnect(): Promise<void>;
  abstract disconnect(): Promise<void>;
  abstract update(): Promise<void>;
  abstract test(): Promise<[boolean] | [boolean, string]>;

  abstract getSecret(name: string): unknown;
  abstract hasSecret(name: string): boolean;
  abstract getSecretNames(): string[];
}
```

The lifecycle surface is pinned by [utils.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/shared/external-secrets/utils.ts:17). The base `connect()` must at least:

- Transition through connection state.
- Call `doConnect()`.
- Set `state = 'connected'` on success.
- Preserve an error state/message on failure.

A successful connection is immediately followed by `update()`, making secret names/values available. Creation consequently returns `state: 'connected'` and current secret summaries.

### Exact fixture behavior

`DummyProvider`:

- `name = 'dummy'`
- `displayName = 'Dummy Provider'`
- Properties:

  - `username`: string, default `''`, required.
  - `other`: string, default `''`.
  - `password`: string, default `''`, `typeOptions.password = true`.

- `update()` publishes `{ test1: 'value1', test2: 'value2' }`.
- `test()` returns `[true]`.
- `getSecret`, `hasSecret`, and `getSecretNames` read its in-memory map.

See [utils.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/shared/external-secrets/utils.ts:17).

`AnotherDummyProvider` is equivalent except:

- `name = 'another_dummy'`
- `displayName = 'Another Dummy Provider'`
- Only a required `username` property.

See [utils.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/shared/external-secrets/utils.ts:83).

Failure fixtures pin:

- `ErrorProvider`: `init`, `update`, `test`, and secret access throw; `doConnect()` throws `Connection failed`.
- `FailedProvider`: `doConnect()` throws `Failed to connect`.
- `TestFailProvider`: connection succeeds, but `test()` returns `[false]`.

See [utils.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/shared/external-secrets/utils.ts:133).

### Provider-specific evidence

| Provider | What surviving specs actually pin |
|---|---|
| AWS Secrets Manager | Settings metadata includes `region`, password fields `accessKeyId`, `secretAccessKey`, `sessionToken`. Create/update accepts examples using those names. [Fixture](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-connections.api.test.ts:23) |
| GCP Secrets Manager | Identity `gcpSecretsManager`; updates accept a settings object such as `{ projectId: 'my-project' }`. No authentication schema, project-selection behavior, or SDK contract is pinned. |
| Vault | Display name `HashiCorp Vault`; icon `vault`; required `url` with placeholder `https://vault.example.com`; required password `token`; optional `namespace`. [Types spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-types.api.test.ts:210) |
| Azure Key Vault | Type identity only. |
| Infisical | Type identity only. |
| 1Password | Type identity only. |

It would not be clean-room-safe to invent the unpinned providers’ authentication modes, paths, pagination, object flattening, or settings fields and claim they came from these specs.

### Settings, testing, and errors

- Provider settings are arbitrary `IDataObject`; API types do not perform provider-specific validation.
- Password-marked properties are redacted with `CREDENTIAL_BLANKING_VALUE`, whose serialized prefix is `__n8n_BLANK_VALUE_`.
- When an update body sends the blanking marker, the stored password must be preserved rather than replaced.
- Legacy `test()`:

  - `[true]` → HTTP 200, `{ success: true, testState: 'connected' }`.
  - `[false]` → HTTP 400, `{ success: false, testState: 'error' }`.

- New stored-connection `test` routes always return HTTP 200 for provider-level failure, with `success: false` and an `error` when connection failed.
- Manual update is refused for an errored provider: HTTP 400 `{ updated: false }`, without invoking `update()`.

The public test-state enum is `connected | tested | error`; runtime connection state is `initializing | initialized | connecting | connected | error | retrying` at [secrets-provider.schema.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/schemas/secrets-provider.schema.ts:20).

## 3. Manager/service contract

### Core interface

`ExternalSecretsManager` must implement:

```ts
interface IExternalSecretsManager {
  hasSecret(provider: string, name: string): boolean;
  getSecret(provider: string, name: string): unknown;
  getSecretNames(provider: string): string[];
  hasProvider(provider: string): boolean;
  getProviderNames(): string[];
}
```

See [external-secrets-proxy.ts](/home/ggrace/linux-coding/n8n/packages/core/src/execution-engine/external-secrets-proxy.ts:3).

Additional tested methods:

- `init()`
- `shutdown()`
- `reloadAllProviders()`
- `getProvider(providerKey)`

### `init()`

`init()` must:

1. Clear or reconcile stale live instances.
2. Select the persistence mode.
3. Instantiate provider classes from the constructor catalog.
4. Register live instances by expression-facing key.
5. Call `init()` on each configured instance.
6. Connect enabled instances.
7. Call `update()` after successful connection.
8. Populate secret names/values used by the proxy and completions.
9. Register itself with `ExternalSecretsProxy.setManager(this)`.

No surviving caller currently invokes `ExternalSecretsProxy.setManager()`, so the rebuilt module must do it. Without this, the proxy returns no providers or secrets.

### Legacy settings mode

When project/multiple-connection storage is disabled:

- Load encrypted settings from `Settings.key = 'feature.externalSecrets'`.
- Shape is effectively:

```ts
type ExternalSecretsSettings = Record<
  string,
  {
    connected: boolean;
    connectedAt: Date | string | null;
    settings: IDataObject;
  }
>;
```

- Instantiate and `init()` all entries.
- Only entries with `connected: true` receive `connect()` and `update()`.
- Disabled entries remain initialized but not connected.

Pinned at [module spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.module.test.ts:48).

### Connection-entity mode

When `externalSecretsForProjects` is enabled:

- Load enabled `SecretsProviderConnection` rows.
- Resolve constructor by row `type`.
- Register instance under row `providerKey`.
- Decrypt `encryptedSettings`.
- `init()`, `connect()`, and `update()` every enabled row.

Pinned at [module spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.module.test.ts:129).

### Reload and shutdown

`reloadAllProviders()` must:

- Disconnect all existing live instances, including initialized-but-disabled legacy instances.
- Clear runtime registry and stale secret data.
- Re-read storage.
- Re-initialize providers.
- Reconnect/update only those enabled by the selected storage model.

The payloadless `reload-external-secrets-providers` pubsub event must invoke this behavior. Legacy reload reconnects only the entry with `connected: true`; entity mode reconnects every enabled row. See [events spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.events.test.ts:26).

`shutdown()` must disconnect providers and release timers/resources. `ExternalSecretsModule.shutdown` must carry `@OnShutdown()` metadata.

### Refresh cadence and cache

The config declares a 300-second polling interval, but no surviving code or spec pins:

- Whether polling starts in manager or module.
- Whether refreshes are serialized.
- Timer type or shutdown ordering.
- Retry/backoff behavior.
- Cache representation or TTL.
- Partial-failure behavior.

What is pinned is immediate consistency after a successful manual `update()`: the next secret-name listing must reflect newly published names. See [legacy API spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:395).

A safe minimum is therefore:

- Treat the live provider as source of truth or refresh cache synchronously after every successful `update()`.
- Invalidate provider cache on disconnect/replacement/deletion.
- Do not retain old secrets after a failed reload.

## 4. REST routes

All module routes are intended to be gated by module license `feat:externalSecrets`. Every API fixture enables that feature, but the exact unlicensed HTTP status is not tested.

The connection scope names below are forced by the surviving permission catalog and role matrix, though the missing controller decorators cannot be inspected:

- `externalSecretsProvider:create`
- `externalSecretsProvider:read`
- `externalSecretsProvider:update`
- `externalSecretsProvider:delete`
- `externalSecretsProvider:list`
- `externalSecretsProvider:sync`
- `externalSecret:list`

The exact forbidden message everywhere it is asserted is:

> `User is missing a scope required to perform this action`

### Global connection controller

| Method/path | Scope | Body | Success | Errors |
|---|---|---|---|---|
| `POST /secret-providers/connections` | `externalSecretsProvider:create` | Required `{ providerKey, type, projectIds, settings }` | 200 full connection; enabled and connected immediately | Duplicate 400: `Connection with key "duplicateTest" already exists`; member 403 |
| `GET /secret-providers/connections` | `externalSecretsProvider:list` | — | 200 `{data: []}` or lightweight connection items; no `settings` | Member 403 |
| `GET /secret-providers/connections/:providerKey` | `externalSecretsProvider:read` | — | 200 full detail with redacted settings | 404 `Connection with key "<key>" not found`; member 403 |
| `PATCH /secret-providers/connections/:providerKey` | `externalSecretsProvider:update` | Optional `type`, `projectIds`, `settings`, `isEnabled` | 200 full detail; settings replace rather than merge; empty project array makes global | 404 same template; member 403 |
| `DELETE /secret-providers/connections/:providerKey` | `externalSecretsProvider:delete` | — | 204, no body; access rows cascade | 404 same template; member 403 |
| `POST /secret-providers/connections/:providerKey/reload` | `externalSecretsProvider:sync` | None | 200 `{data:{success:true}}`; invokes `update()` | 404 same template; member 403 |
| `POST /secret-providers/connections/:providerKey/test` | `externalSecretsProvider:sync` | None in specs | 200 test response, including failed provider tests | 404 same template; member 403 |

Evidence: [connections API spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-connections.api.test.ts:113).

Create DTO validation:

- `providerKey`: 1–128 characters, first character ASCII letter, remainder ASCII letters/digits.
- `type`: six-value enum.
- `projectIds`: required string array; each entry nonempty.
- `settings`: arbitrary object.

See [create DTO](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/secrets-provider/create-secrets-provider-connection.dto.ts:10).

Full response shape:

```ts
{
  id: string;
  name: string; // providerKey
  type: SecretsProviderType;
  state: SecretsProviderState;
  isEnabled: boolean;
  projects: Array<{ id: string; name: string; role?: SecretsProviderAccessRole }>;
  settings: IDataObject;
  secretsCount: number;
  secrets?: Array<{ name: string; credentialsCount?: number }>;
  scopes?: string[];
  createdAt: string;
  updatedAt: string;
}
```

List items remove `settings` and `secrets`. See [response schema](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/schemas/secrets-provider.schema.ts:75).

### Project connection controller

| Method/path | Scope | Behavior/statuses |
|---|---|---|
| `GET /secret-providers/projects/:projectId/connections` | `externalSecretsProvider:list` in project context | 200 global connections plus those granted to the project; excludes other projects; empty array when none |
| `POST /secret-providers/projects/:projectId/connections` | `externalSecretsProvider:create` | 200; creates a connection owned by exactly the path project, ignoring body `projectIds`; duplicate 400 |
| `GET /secret-providers/projects/:projectId/connections/:providerKey` | `externalSecretsProvider:read` | 200 for project-owned or global connection; 404 for another project or missing |
| `PATCH /secret-providers/projects/:projectId/connections/:providerKey` | `externalSecretsProvider:update` | 200; updates type/settings; ignores body `projectIds`; 404 for global, another project, or missing |
| `DELETE /secret-providers/projects/:projectId/connections/:providerKey` | `externalSecretsProvider:delete` | 204 for project-owned connection; deletes connection; 404 for global, another project, or missing |
| `POST /secret-providers/projects/:projectId/connections/:providerKey/test` | `externalSecretsProvider:sync` | 200 test result for project-owned connection; 404 for global, another project, or missing |

Owner/admin are allowed; ordinary member is denied with the exact forbidden message. The only project-route not-found text directly asserted is a lowercase `not found` fragment; the full message is not pinned. See [project API spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-project.api.test.ts:107).

### Provider-type controller

| Method/path | Access | Success/errors |
|---|---|---|
| `GET /secret-providers/types` | Any authenticated owner/admin/member | 200 all registered constructor metadata, or `[]` |
| `GET /secret-providers/types/:type` | Any authenticated owner/admin/member | 200 metadata; missing returns exactly `{ code: 404, message: 'Provider type "non_existent" not found' }` |

Metadata is `{ type, displayName, icon, properties }`. See [types API spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secret-providers-types.api.test.ts:63).

### Completions controller

| Method/path | Scope | Success |
|---|---|---|
| `GET /secret-providers/completions/secrets/global` | Global `externalSecret:list` | 200 `{providerKey: secretName[]}` for global connections only |
| `GET /secret-providers/completions/secrets/global/:projectId` | `externalSecret:list` resolved for the named project | 200 same global-only data |
| `GET /secret-providers/completions/secrets/project/:projectId` | Project `externalSecret:list` | 200 only project-scoped connections assigned to that project |

See §6 for filtering details.

### Legacy controller

These routes operate when project/multiple-connection mode is disabled:

| Method/path | Body | Success/failure |
|---|---|---|
| `GET /external-secrets/providers` | — | Owner 200 provider summaries; member 403 |
| `GET /external-secrets/providers/:provider` | — | Owner 200 detail including properties; member 403 |
| `POST /external-secrets/providers/:provider` | Raw settings object | 200; blanking marker preserves prior password |
| `POST /external-secrets/providers/:provider/connect` | `{ connected: boolean }` | 200; `{connected:false}` yields `state:'initializing'` |
| `POST /external-secrets/providers/:provider/test` | Raw settings object | Success 200; failed tuple 400 |
| `POST /external-secrets/providers/:provider/update` | None | 200 `{updated:true}` or 400 `{updated:false}` for errored provider |
| `GET /external-secrets/secrets` | — | Owner 200 provider-to-secret-name map; member 403 |

The legacy specs only prove owner/member behavior, not the exact scope decorator or admin behavior. See [legacy API spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.api.test.ts:190).

### Exported DTOs with no pinned route

These exist but no named API spec exercises a corresponding endpoint:

- `SetSecretsProviderConnectionIsEnabledDto { isEnabled: boolean }`
- `UpdateExternalSecretsSettingsDto { systemRolesEnabled: boolean }`
- `TestSecretsProviderConnectionDto`, arbitrary settings object

Their endpoint paths/statuses must not be invented from this corpus.

## 5. Project access and project deletion

### Access-row meaning

`ProjectSecretsProviderAccess.role` is:

- `secretsProviderConnection:owner`
- `secretsProviderConnection:user`

A connection with zero access rows is global. Otherwise it is available only to projects appearing in access rows.

Creation semantics:

- Global connection API with `projectIds` creates `user` grants.
- Project-context creation creates exactly one `owner` grant for the path project.
- Project-context update cannot reassign ownership using body `projectIds`.

The surviving access-check service implements:

```ts
missing provider       => false
provider with no grants => true
otherwise               => grants.some(g => g.projectId === projectId)
```

It currently ignores `isEnabled`, role, config, and license state. See [access-check service](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/external-secrets/secret-provider-access-check.service.ts:16).

### Deleting a project through the API

`DELETE /projects/:projectId` is protected by `project:delete`; the test-observed status is 200. External-secret cleanup must be part of one transaction with project deletion:

- For every `owner` grant belonging to the deleted project: delete the connection.
- For every `user` grant: keep the connection, set `isEnabled = false`, and delete the access row.
- Mixed owner/user connections must receive the appropriate per-row behavior.
- If connection deletion fails, project and access rows remain.
- If access-row deletion fails, owner-connection deletion and project deletion roll back.

See [project-deletion spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/project-deletion.api.test.ts:102).

The current [ProjectService deletion flow](/home/ggrace/linux-coding/n8n/packages/cli/src/services/project.service.ts:379) is sequential and has no external-secret cleanup or encompassing transaction. The rebuild must add that integration using the persistence-layer transaction boundary.

A raw `ProjectRepository.delete()` has intentionally weaker behavior: DB cascade removes access rows while leaving the connection alive, which then appears global. That behavior is separately pinned by the connections spec. The stronger disable/delete semantics apply to the project-deletion service/API flow.

`transferId` behavior for external-secret ownership is not tested.

## 6. Completions contract

Response type is always:

```ts
Record<string, string[]>
```

where keys are expression-facing connection `providerKey`s and values are current secret names.

### Global without project context

`GET /secret-providers/completions/secrets/global`:

- Requires global `externalSecret:list`.
- Owner/admin succeed.
- Ordinary member fails.
- A member holding only a project-level custom `externalSecret:list` role still fails.
- Returns enabled global connections only.
- Excludes project-scoped connections.
- Returns `{}` when none exist.

### Global with project context

`GET /secret-providers/completions/secrets/global/:projectId`:

- Resolves `externalSecret:list` against the named project.
- A project custom-role member succeeds only for their assigned project.
- Returns the same global-only data as the non-project global route.
- Does not include connections assigned to that project.

### Project-specific

`GET /secret-providers/completions/secrets/project/:projectId`:

- Resolves `externalSecret:list` against the project.
- Returns only connections assigned to that exact project.
- Excludes global and other-project connections.
- Missing project returns 200 `{data:{}}`, not 404.
- Project with no connections returns `{}`.

All asserted denials use the verbatim forbidden message. See [completions spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/secrets-providers-completions.api.test.ts:124).

Ordering, disabled/error providers, empty-secret providers, duplicate names, and partial manager failures are not pinned.

## 7. Events, telemetry, and audit

The 177-line `external-secrets.events.test.ts` pins only the payloadless pubsub command:

```ts
'reload-external-secrets-providers': never
```

and the reload lifecycle described in §3. It does not itself assert telemetry.

The surviving relay map separately pins these application events:

| Relay event | Payload |
|---|---|
| `external-secrets-provider-settings-saved` | `{ userId?, vaultType, isValid, isNew, errorMessage? }` |
| `external-secrets-provider-reloaded` | `{ vaultType }` |
| `external-secrets-connection-created` | `{ userId, userRole?, providerKey, vaultType, projects }` |
| `external-secrets-connection-updated` | Same |
| `external-secrets-connection-deleted` | Same |
| `external-secrets-connection-tested` | Same plus `{ isValid, errorMessage? }` |
| `external-secrets-connection-reloaded` | Connection-style payload |
| `external-secrets-system-roles-toggled` | `{ userId, enabled }` |

See [relay.event-map.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/events/maps/relay.event-map.ts:754).

Telemetry mappings:

- `User updated external secrets settings`
  - `user_id`, `vault_type`, `is_valid`, `is_new`, `error_message`
- `User reloaded external secrets`
  - `vault_type`
- `User created external secrets connection`
- `User updated external secrets connection`
- `User deleted external secrets connection`
  - `user_id`, `user_role`, `vault_type`
  - `scope: 'global' | 'project'`
  - `project_ids`
- `User toggled external secrets system roles`
  - `user_id`, `enabled`

See [telemetry relay](/home/ggrace/linux-coding/n8n/packages/cli/src/events/relays/telemetry.event-relay.ts:447).

`providerKey` exists in connection relay payloads but is not forwarded to telemetry.

Audit event names are:

- `n8n.audit.external-secrets.provider.settings.saved`
- `n8n.audit.external-secrets.provider.reloaded`
- `n8n.audit.external-secrets.connection.created`
- `n8n.audit.external-secrets.connection.updated`
- `n8n.audit.external-secrets.connection.deleted`
- `n8n.audit.external-secrets.connection.tested`
- `n8n.audit.external-secrets.connection.reloaded`

The full relay payload is forwarded unchanged. See [log-streaming relay](/home/ggrace/linux-coding/n8n/packages/cli/src/events/relays/log-streaming.event-relay.ts:730).

Connection tested/reloaded are audit-only. System-role toggling is telemetry-only. No surviving producer currently emits these events, so rebuilt mutation/test/reload paths must do so.

## 8. Database schema and repositories

### `secrets_provider_connection`

Created by [migration 1769433700000](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1769433700000-CreateSecretsProvidersConnectionTables.ts:9):

| Column | Contract |
|---|---|
| `id` | Integer, generated primary key |
| `providerKey` | `varchar(128) NOT NULL`, unique index |
| `type` | `varchar(36) NOT NULL`; comment names AWS/GCP/Vault/Azure/Infisical; no DB enum/check |
| `encryptedSettings` | `text NOT NULL` |
| `isEnabled` | Boolean, `NOT NULL DEFAULT false` |
| `createdAt`, `updatedAt` | Precision-3 timestamps, non-null, current-time defaults |

Entity mapping is [SecretsProviderConnection](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/entities/secrets-provider-connection.ts:6). It eagerly loads `projectAccess`.

### `project_secrets_provider_access`

| Column | Contract |
|---|---|
| `secretsProviderConnectionId` | Integer, composite PK, FK to connection, `ON DELETE CASCADE` |
| `projectId` | `varchar(36)`, composite PK, FK to project, `ON DELETE CASCADE` |
| `role` | `varchar(128) NOT NULL DEFAULT 'secretsProviderConnection:user'`; check constraint for owner/user |
| `createdAt`, `updatedAt` | Precision-3 timestamps |

The role is added by [migration 1772619247761](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1772619247761-AddRoleColumnToProjectSecretsProviderAccess.ts:8). Entity mapping is [ProjectSecretsProviderAccess](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/entities/project-secrets-provider-access.ts:11).

### Required repository behavior

Existing `SecretsProviderConnectionRepository` provides:

- `findIdByProviderKey(key)` → decimal ID string or `null`.
- `findIdsByProviderKeys(keys)` → found IDs as strings; `[]` short-circuits; no order guarantee.
- `findByProviderKeyWithAccess(key)` → connection with project grants or `null`.
- `findAllAccessibleProviderKeysByCredentialId(id)`:

  - Includes all global providers.
  - Includes a scoped provider when any project sharing the credential has a matching grant.
  - Does not filter `isEnabled` or grant role.
  - Has no explicit ordering.

See [repository](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/repositories/secrets-provider-connection.repository.ts:12).

The surviving repository spec additionally requires two currently missing methods:

```ts
findEnabledGlobalConnections(options?: {
  providerKeys?: string[];
}): Promise<SecretsProviderConnection[]>;

findEnabledByProjectId(
  projectId: string,
  options?: { providerKeys?: string[] },
): Promise<SecretsProviderConnection[]>;
```

Contracts:

- Global method returns only connections with zero access rows.
- Project method returns only connections assigned to the exact project and excludes global rows.
- Optional provider-key filtering applies.
- Explicit empty `providerKeys` returns `[]`.
- Ordering is unpinned.
- Despite “Enabled” in the names, disabled exclusion is not directly tested because every fixture is enabled.

See [repository spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/database/repositories/secrets-provider-connection.repository.test.ts:99).

`ProjectSecretsProviderAccessRepository` is imported throughout the specs but does not exist or export from `@n8n/db`. It must be restored as a DI repository exposing at least inherited:

- `create`
- `save`
- `find`
- `findOneBy`
- `findOneByOrFail`
- `delete`
- `target` compatibility used by rollback tests

### Legacy data migration

[Migration 1771500000000](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1771500000000-MigrateExternalSecretsToEntityStorage.ts:19):

- Reads `settings.key = 'feature.externalSecrets'`.
- Decrypts with the instance key and JSON-parses.
- Skips missing/empty/undecryptable settings.
- Skips disconnected providers.
- Skips duplicate provider keys.
- Inserts `providerKey = providerName`, `type = providerName`.
- Re-encrypts the settings.
- Adds no project-access rows, making migrated rows global.
- Preserves the old settings row.

Important contradiction: it migrates only legacy entries marked connected but omits `isEnabled`, so the DB default makes the new row disabled. That behavior is explicit in the surviving migration and should be resolved deliberately during implementation rather than silently inherited.

## 9. `$secrets` expression integration

`ExternalSecretsProxy` is placed in workflow additional data at [workflow-execute-additional-data.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/workflow-execute-additional-data.ts:801).

Exposure rules:

- Normal workflow/node expressions receive `$secrets: undefined`.
- Credential expression evaluation passes `isCredential: true` and receives the proxy.
- Non-workflow expression evaluation must explicitly pass `secretsEnabled: true`.

See [get-additional-keys.ts](/home/ggrace/linux-coding/n8n/packages/core/src/execution-engine/node-execution-context/utils/get-additional-keys.ts:20).

The expression spec proves:

- A Set node cannot resolve `$secrets`; proxy methods are not called and the secret must not appear anywhere in run data.
- A credential expression resolves successfully.

See [expression integration spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/external-secrets/external-secrets.expression-access.test.ts:147).

### Proxy behavior

- Missing/inaccessible provider throws:

  - Title: `Could not load secrets`
  - Description: `The credential in use pulls secrets from an external store that is not reachable`

- Missing secret or nested property throws:

  - Title: `Could not load secrets`
  - Description: `The credential in use tries to use secret from an external store that could not be found`

- Nested object secret values remain recursively accessible.
- Assignment is rejected.
- `ownKeys()` exposes provider/secret names.

See [get-secrets-proxy.ts](/home/ggrace/linux-coding/n8n/packages/core/src/execution-engine/node-execution-context/utils/get-secrets-proxy.ts:4).

When project scoping and the license are enabled, credential decryption populates `externalSecretProviderKeysAccessibleByCredential` from repository results. An undefined allowlist currently means unrestricted provider access; only a defined set restricts providers. See [credentials-helper.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/credentials-helper.ts:579).

Credential-save validation separately requires `externalSecret:list` when adding/changing a `$secrets` expression. Exact error:

> `Lacking permissions to reference external secrets in credentials`

Project/provider validation uses these exact singular/plural templates:

> `The secret provider "<provider>" used in "<field>" does not exist in this project`

> `The secret providers "<provider>" (used in "<field>"), ... do not exist in this project`

For transfer, the suffix is `in the destination project`. See [validation.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/credentials/validation.ts:46).

## 10. Module registration and licensing

`external-secrets` is already a default module at [module-registry.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/backend-common/src/modules/module-registry.ts:43).

The rebuilt entrypoint should follow the surviving pattern:

```ts
@BackendModule({
  name: 'external-secrets',
  licenseFlag: 'feat:externalSecrets',
})
export class ExternalSecretsModule implements ModuleInterface {
  async init() {
    // dynamic-import controllers/services
    // initialize manager
    // register pubsub handler
  }

  async settings() {
    // external-secrets frontend module settings
  }

  @OnShutdown()
  async shutdown() {
    // manager shutdown
  }
}
```

Relevant conventions:

- [LDAP module](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/ldap/ldap.module.ts:5)
- [log-streaming module](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/log-streaming/log-streaming.module.ts:5)
- [provisioning module](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/provisioning/provisioning.module.ts:10)

`ModuleRegistry.initModules()` skips an unlicensed module before calling `init()`, so module-level gating prevents controller registration and lifecycle startup. See [module-registry.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/backend-common/src/modules/module-registry.ts:157).

License methods:

- `LicenseState.isExternalSecretsLicensed()` → `isLicensed('feat:externalSecrets')`.
- Legacy `License.isExternalSecretsEnabled()` delegates to the same feature.

See [license-state.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/backend-common/src/license-state.ts:157).

Instance-type restrictions are not pinned. Since `$secrets` resolution is required during execution and the proxy must have a manager, restricting initialization to main-only would require a separately proven worker strategy; none survives here.

Permissions:

- `externalSecretsProvider`: `sync/create/read/update/delete/list`
- `externalSecret`: `list`

Connection-sharing roles:

- Owner: provider `read/update/delete/list/sync` plus secret `list`.
- User: secret `list` only.

See [sharing scopes](/home/ggrace/linux-coding/n8n/packages/@n8n/permissions/src/roles/scopes/secrets-provider-connection-sharing-scopes.ts:4).

The setting `externalSecrets.systemRoles.enabled` survives, but its current `roleScopeMap` is empty. Therefore toggling it currently grants no scopes. See [permissions settings](/home/ggrace/linux-coding/n8n/packages/@n8n/permissions/src/settings.ts:18).

## 11. Explicitly open or under-pinned areas

These must remain design decisions rather than reconstructed “facts”:

1. **Actual SDK behavior.** AWS/GCP/Vault/Azure/Infisical/1Password authentication, pagination, namespaces, versions, flattening, and error translation are absent.
2. **Provider coverage.** Six identities are public, but only AWS/Vault have meaningful settings metadata; GCP has one accepted example.
3. **Exact controller/service filenames and class names.** Route grouping is pinned; internal split is not.
4. **Periodic refresh.** Only the 300-second config exists. Timer, concurrency, retry, backoff, jitter, and failure isolation are absent.
5. **Cache design.** No TTL, storage shape, atomicity, or stale-value policy survives.
6. **License-disabled response.** Module skipping is established; exact API status/body is untested.
7. **Unauthenticated behavior.** Not tested.
8. **Scope decorators.** Completion scope `externalSecret:list` is explicit. Connection scope names are strongly determined by the permission catalog/action matrix but cannot be verified against missing controllers.
9. **System-role settings route.** DTO and frontend shape survive, but path/status/persistence behavior do not.
10. **Enable/disable endpoint.** DTO exists; route is unpinned.
11. **Provider validation.** `settings` is an arbitrary catchall object; no malformed-setting contract exists.
12. **State transitions.** Success/error endpoints pin terminal outcomes, but intermediate `initialized`, `connecting`, and `retrying` transitions are not tested.
13. **Response ordering.** Providers, connections, projects, and secret names have no ordering contract.
14. **Disabled-provider filtering.** Repository methods are named `findEnabled*`, but no disabled fixture tests them.
15. **Partial reload results.** Public response permits `providers?: Record<string,{success:boolean}>`; no spec exercises it.
16. **Project deletion with transfer.** External-secret ownership behavior under `transferId` is absent.
17. **Multiple grants/owners.** Owner plus grants to other projects is not covered.
18. **Migration enablement defect.** Connected legacy entries become disabled entity rows unless explicitly corrected.
19. **Public enum versus runtime extensibility.** Public responses are typed with the six-value enum, but type API specs return arbitrary test catalog keys.
20. **Provider-key inconsistency.** Create DTO forbids hyphens, while completions fixtures insert hyphenated keys directly into storage.
21. **Legacy `connectedAt`.** API type declares `string | false`; test helper also permits `null`.
22. **Project allowlist fallback.** Undefined `externalSecretProviderKeysAccessibleByCredential` currently means unrestricted access, acknowledged by a surviving TODO.
23. **Missing implementation exports.** `ProjectSecretsProviderAccessRepository`, `findEnabledGlobalConnections`, and `findEnabledByProjectId` are absent today.
24. **Current test imports.** The acceptance specs and test-server still reference purged `.ee` module paths and must be migrated completely.

## Verification ledger

Read to EOF:

- Eight named external-secrets specs: 3,652 lines.
- Shared provider fixture: 332 lines.
- Full test-server helper: 424 lines.
- Named acceptance corpus total: **4,408 lines**.
- Additional expression integration spec: 288 lines.
- Total external-secrets integration surface reviewed: **4,696 lines**.
- All named DB entities, repositories, migrations, DTOs/schemas, permission definitions, event maps/relays, license methods, execution consumers, and module-registration examples were inspected.
- `packages/cli/src` was re-grepped and contains zero `external-secrets.ee` references.
- The worktree remained unchanged.