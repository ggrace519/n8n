# Clean-room rebuild contract: dynamic credentials

The rebuild is well pinned for persistence, per-user connection state, manual identity resolution, core credential integration, and role enforcement. Custom resolver behavior and its dedicated controllers are only partially pinned and must not be invented silently.

I inspected the requested 5,357 lines of surviving specs plus the 18-line implementation, migrations, API types, permission maps, module loader, workflow/OAuth consumers, and credential subsystem. I did not inspect history, upstream Enterprise code, compiled artifacts, or any removed file. The worktree remains unchanged.

Terminology below:

- **Pinned** — directly required by a named acceptance spec, migration, or surviving callable interface.
- **Required integration** — demanded by surviving fair-code consumers, though not fully specified by the named tests.
- **Under-pinned** — behavior or naming that needs a new clean-room decision and tests.

## 1. Module file map and required exports

All rebuild paths must be under `packages/cli/src/modules/dynamic-credentials/`, never a `.ee` path. The surviving tests’ stale imports must be changed accordingly.

| Required path | Export | Contract status |
|---|---|---|
| `constants.ts` | `SYSTEM_RESOLVER_ID`, `SYSTEM_RESOLVER_NAME`, `SYSTEM_RESOLVER_TYPE` | All names pinned; only `SYSTEM_RESOLVER_ID = 'system-n8n'` has a surviving value |
| `dynamic-credentials.config.ts` | `DynamicCredentialsConfig` | Class and three fields pinned |
| `errors/credential-resolution.error.ts` | `CredentialResolutionError` | Class identity pinned by `instanceof`/`toThrow`; inheritance and metadata under-pinned |
| `database/entities/credential-resolver.ts` | `DynamicCredentialResolver` | Pinned |
| `database/entities/dynamic-credential-entry.ts` | `DynamicCredentialEntry` | Pinned |
| `database/entities/dynamic-credential-user-entry.ts` | `DynamicCredentialUserEntry` | Pinned |
| `database/entities/index.ts` | entity exports or array used by module registration | Conventional, exact barrel shape under-pinned |
| `database/repositories/credential-resolver.repository.ts` | `DynamicCredentialResolverRepository` | Pinned |
| `database/repositories/dynamic-credential-entry.repository.ts` | `DynamicCredentialEntryRepository` | Pinned |
| `database/repositories/dynamic-credential-user-entry.repository.ts` | `DynamicCredentialUserEntryRepository` | Pinned |
| `credential-resolvers/storage/dynamic-credential-entry-storage.ts` | `DynamicCredentialEntryStorage` | Pinned |
| `credential-resolvers/storage/dynamic-credential-user-entry-storage.ts` | `DynamicCredentialUserEntryStorage` | Pinned |
| `credential-resolvers/identifiers/n8n-identifier.ts` | `N8NIdentifier` | Manual-cookie behavior pinned |
| `services/shared-fields.ts` | `getChangedSharedFields` | Already survives |
| `services/credential-connection-status.service.ts` | provider implementing `ICredentialConnectionStatusProvider` | Required by core proxy and explicitly named in surviving lint configuration |
| `services/credential-resolver.service.ts` | provider implementing both `ICredentialResolutionProvider` and `IDynamicCredentialStorageProvider`, or equivalent registered objects | Required by `DynamicCredentialsProxy`; exact class split under-pinned |
| `services/credential-resolver-workflow.service.ts` | resolver/workflow lookup and cleanup service | Required by surviving lint entry and `WorkflowRepository` methods |
| `dynamic-credentials.module.ts` | `DynamicCredentialsModule implements ModuleInterface` | Required for `testModules.loadModules(['dynamic-credentials'])` and default module registration |
| Controller for resolver CRUD | likely `CredentialResolverController` | Routes are consumed by the frontend; exact filename/class/decorator behavior is under-pinned |
| Controller for execution status/authorize/revoke | likely `DynamicCredentialsController` | Explicitly referenced by surviving OAuth comments and frontend routes; behavior under-pinned |

The module entry must:

1. Register all three entities from `entities()` before datasource creation.
2. On initialization, register resolution and storage providers on `DynamicCredentialsProxy`.
3. Register the connection-status provider on `CredentialConnectionStatusProxy`.
4. Seed the system resolver idempotently.
5. Register HTTP controllers on processes that host REST routes.
6. Expose `{ credentialCheckProxy }` through `context()` under the `dynamic-credentials` namespace, because webhook execution reads:

```ts
additionalData['dynamic-credentials']?.credentialCheckProxy
```

7. Initialize on every execution process that may resolve credentials. Restricting it to `main` would break webhook/worker resolution; either omit `instanceTypes` or include at least `main`, `webhook`, and `worker`.
8. Be licensed under `feat:dynamicCredentials` if following the existing licensed-module convention. The named REST spec runs with that feature enabled, but disabled-license behavior is not pinned.

The default module registry already lists `dynamic-credentials` and first attempts the fair-code path before the obsolete Enterprise fallback.

Sources: [module registry](/home/ggrace/linux-coding/n8n/packages/@n8n/backend-common/src/modules/module-registry.ts:43), [module interface](/home/ggrace/linux-coding/n8n/packages/@n8n/decorators/src/module/module.ts:40), [surviving implementation](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/dynamic-credentials/services/shared-fields.ts:1).

## 2. Database schema and entity mappings

All three tables include:

- `createdAt`: timestamp with millisecond precision, non-null, default `NOW()`
- `updatedAt`: timestamp with millisecond precision, non-null, default `NOW()`

The DSL maps these to `timestamptz(3)` on PostgreSQL and `datetime(3)` on SQLite.

### `DynamicCredentialResolver`

Table: `dynamic_credential_resolver`

| Column | Type | Null | Constraint |
|---|---|---:|---|
| `id` | `varchar(16)` | No | Primary key |
| `name` | `varchar(128)` | No | — |
| `type` | `varchar(128)` | No | Non-unique index |
| `config` | `text` | No | Comment: `Encrypted resolver configuration (JSON encrypted as string)` |
| `createdAt` | timestamp(3) | No | Default current time |
| `updatedAt` | timestamp(3) | No | Default current time |

No uniqueness exists on `name`, `type`, or their combination.

Expected entity shape:

```ts
class DynamicCredentialResolver extends WithTimestampsAndStringId {
  id: string;
  name: string;
  type: string;
  config: string;
  createdAt: Date;
  updatedAt: Date;
}
```

The generated id must fit 16 characters.

### `DynamicCredentialEntry`

Table: `dynamic_credential_entry`

| Column | Type | Null | Constraint |
|---|---|---:|---|
| `credential_id` | `varchar(16)` | No | Composite PK; FK to `credentials_entity.id`, `ON DELETE CASCADE` |
| `subject_id` | `varchar(2048)` | No | Composite PK; indexed |
| `resolver_id` | `varchar(16)` | No | Composite PK; indexed; FK to `dynamic_credential_resolver.id`, `ON DELETE CASCADE` |
| `data` | `text` | No | — |
| timestamps | timestamp(3) | No | — |

The original `subject_id` length was 16; the final schema expands it to 2,048. The primary key is exactly:

```text
(credential_id, subject_id, resolver_id)
```

Required entity properties and relations:

```ts
credentialId: string; // maps credential_id
subjectId: string;    // maps subject_id
resolverId: string;   // maps resolver_id
data: string;
credential: CredentialsEntity;       // ManyToOne
resolver: DynamicCredentialResolver; // ManyToOne
createdAt: Date;
updatedAt: Date;
```

### `DynamicCredentialUserEntry`

Table: `dynamic_credential_user_entry`

Unlike the generic entry table, its database column names are camelCase.

| Column | Type | Null | Constraint |
|---|---|---:|---|
| `credentialId` | `varchar(16)` | No | Composite PK; FK to `credentials_entity.id`, `ON DELETE CASCADE` |
| `userId` | UUID (`varchar` on SQLite) | No | Composite PK; indexed; FK to `user.id`, `ON DELETE CASCADE` |
| `resolverId` | `varchar(16)` | No | Composite PK; indexed; FK to `dynamic_credential_resolver.id`, `ON DELETE CASCADE` |
| `data` | `text` | No | — |
| timestamps | timestamp(3) | No | — |

Primary key:

```text
(credentialId, userId, resolverId)
```

Required relations:

```ts
credential: CredentialsEntity;
user: User;
resolver: DynamicCredentialResolver;
```

All three are loadable together.

### Additions to `credentials_entity`

| Column | Type | Null | Default/constraint |
|---|---|---:|---|
| `isResolvable` | boolean | No | `false` |
| `resolvableAllowFallback` | boolean | No | `false` |
| `resolverId` | `varchar(16)` | Yes | FK `credentials_entity_resolverId_foreign` to resolver id, `ON DELETE SET NULL` |

Deleting a resolver therefore:

- sets linked `credentials_entity.resolverId` to `NULL`;
- deletes generic entries;
- deletes per-user entries.

It does not delete the credential itself.

Sources: [resolver migration](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1764682447000-CreateCredentialResolverTable.ts:1), [generic entry migration](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1764689388394-AddDynamicCredentialEntryTable.ts:1), [subject expansion](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1769784356000-ExpandSubjectIDColumnLength.ts:1), [user entry migration](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1768901721000-AddDynamicCredentialUserEntryTable.ts:1), [credential fields migration](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1765459448000-AddResolvableFieldsToCredentials.ts:1).

## 3. Repository contracts

The specs exercise normal TypeORM repository methods. Repositories may add use-case methods for storage and transaction support, but the inherited operations below must remain available.

Following the current persistence boundary, these repositories should live in `database/repositories`, extend `BaseRepository<T>`, and use `managerFor(ctx)` for context-aware custom operations.

### `DynamicCredentialResolverRepository`

Required surface:

```ts
create(input): DynamicCredentialResolver
save(entity): Promise<DynamicCredentialResolver>
findOne({ where: { id } }): Promise<DynamicCredentialResolver | null>
delete(id | criteria): Promise<DeleteResult>
```

Semantics:

- `create()` does not persist.
- Saving without an id generates a valid id.
- `name`, `type`, and the encrypted `config` string round-trip.
- Credentials can be queried independently with `{ resolverId }`.
- A credential may have `resolverId = null`.
- Deleting the resolver sets linked credential `resolverId` to null.
- Entry-table cascades occur through the database FKs.
- No uniqueness or ordering contract is specified.

### `DynamicCredentialEntryRepository`

Required surface:

```ts
save(entry | entry[]): Promise<DynamicCredentialEntry | DynamicCredentialEntry[]>
findOne(options): Promise<DynamicCredentialEntry | null>
find(options): Promise<DynamicCredentialEntry[]>
delete(criteria): Promise<DeleteResult>
```

Exact identity/scoping is the full composite key:

```ts
{ credentialId, subjectId, resolverId }
```

Required behavior:

- Data and all key fields round-trip.
- `createdAt` and `updatedAt` are `Date` instances.
- Credential deletion cascades every entry for that credential.
- Resolver deletion cascades every entry for that resolver.
- `relations: ['credential']` populates `entry.credential`.
- `relations: ['resolver']` populates `entry.resolver`.
- Nested relation filters work:

```ts
where: { credential: { type: 'oAuth2Api' } }
where: { resolver: { type: 'aws-secrets-manager' } }
where: {
  credential: { type: 'oAuth2Api' },
  resolver: { type: 'aws-secrets-manager' },
}
```

- Multiple criteria combine with logical AND.
- The specs sort returned identifiers before comparison; repository ordering is intentionally unspecified.
- Direct repository conflict/upsert behavior is not independently tested. Storage-level upsert is pinned.

### `DynamicCredentialUserEntryRepository`

Required surface:

```ts
save(entry | entry[]): Promise<...>
findOne(options): Promise<DynamicCredentialUserEntry | null>
find(options): Promise<DynamicCredentialUserEntry[]>
delete(compositeKey): Promise<DeleteResult>
countBy(criteria): Promise<number>
```

Identity:

```ts
{ credentialId, userId, resolverId }
```

Required behavior:

- Saving a second object with the same composite key updates `data`; it must not insert a duplicate.
- Exact-key deletion removes only that row.
- `find({ where: { credentialId } })` returns all matching users/resolvers.
- Deleting a credential, user, or resolver cascades its matching rows.
- Relations `credential`, `user`, and `resolver` are individually and jointly loadable.
- Required filters:

```ts
where: { userId }
where: { credential: { type } }
where: { resolver: { type } }
where: { user: { email } }
where: {
  credential: { type },
  user: { id },
  resolver: { type },
}
```

- Combined filters are ANDed.
- Ordering remains unspecified.

### Connection-status query requirements

`CredentialConnectionStatusService.findConnectedCredentialIds()` must issue one bulk `DynamicCredentialUserEntryRepository.find()` call for a credential list, with at least:

```ts
where: {
  userId,
  credentialId: In(credentialIds),
  resolverId: SYSTEM_RESOLVER_ID,
}
```

The named REST test spies specifically on `.find()` and requires one invocation. It checks `userId` and a non-empty `credentialId` condition; the system-resolver scoping is stated by the fixture and provider interface.

Other required provider semantics:

- `countConnectedUsers(credentialId)` counts distinct users under the system resolver.
- `deleteAllUserEntries(credentialId, em?)` deletes every per-user row for the credential.
- `cleanupOrphanedEntriesForUsers(...)` reevaluates `credential:connect` across all resolvers.
- `cleanupOrphanedEntriesForProjects(...)` reevaluates affected project members for one credential.
- Optional `EntityManager` parameters must keep cleanup within the caller’s transaction.

## 4. Storage class contracts

Storage data is opaque text. The storage classes do not receive plaintext credential objects in these specs and must not assume the string format; encryption/decryption belongs above or outside this layer.

### `DynamicCredentialEntryStorage`

Required signatures:

```ts
setCredentialData(
  credentialId: string,
  subjectId: string,
  resolverId: string,
  data: string,
  ctx: OperationContext,
): Promise<void>;

getCredentialData(
  credentialId: string,
  subjectId: string,
  resolverId: string,
  ctx: OperationContext,
): Promise<string | null>;

deleteCredentialData(
  credentialId: string,
  subjectId: string,
  resolverId: string,
  ctx: OperationContext,
): Promise<void>;
```

Semantics:

- `set` inserts or updates on the composite triple.
- A second `set` replaces only the matching row’s `data`.
- `get` returns the exact stored string or `null`.
- `delete` is idempotent from the caller’s perspective and affects only the exact triple.
- Different credentials, subjects, and resolvers are fully isolated.
- The supplied `OperationContext` must be threaded into the repository manager, even though the tests pass `{}`.
- No bulk-delete method is pinned for this class.

### `DynamicCredentialUserEntryStorage`

Required signatures:

```ts
setCredentialData(
  credentialId: string,
  userId: string,
  resolverId: string,
  data: string,
  ctx: OperationContext,
): Promise<void>;

getCredentialData(
  credentialId: string,
  userId: string,
  resolverId: string,
  ctx: OperationContext,
): Promise<string | null>;

deleteCredentialData(
  credentialId: string,
  userId: string,
  resolverId: string,
  ctx: OperationContext,
): Promise<void>;

deleteAllCredentialData(input: {
  resolverId: string;
  resolverName: string;
  configuration: Record<string, unknown>;
}): Promise<void>;
```

Semantics:

- Same insert/update/get/delete behavior as the generic storage, keyed by user rather than arbitrary subject.
- A miss returns `null`.
- User deletion removes all of that user’s entries across credentials and resolvers.
- Other users’ rows remain intact.
- Deleting a user with no entries succeeds.
- `deleteAllCredentialData()` deletes all rows for `input.resolverId`, across credentials and users.
- It leaves other resolvers’ rows intact.
- The named tests do not assign semantics to `resolverName` or `configuration`; only `resolverId` affects deletion.

Sources: [generic storage spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/dynamic-credentials/dynamic-credential-entry-storage.test.ts:1), [user storage spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/dynamic-credentials/dynamic-credential-user-entry-storage.test.ts:1).

## 5. Credential resolver and `N8NIdentifier`

### Credential-context wire contract

`n8n-workflow` pins the decrypted credential context to:

```ts
type ICredentialContext = {
  version: 1;
  identity: string;
  metadata?: Record<string, unknown>;
};
```

`toCredentialContext(value)`:

- accepts an object or JSON string;
- requires `version: 1`;
- requires string `identity`;
- validates optional record-shaped metadata;
- rejects invalid content with `Failed to parse to valid ICredentialContext`.

Persisted `IExecutionContext.credentials` is always an encrypted string. Plain credential contexts must never be persisted or returned through APIs.

### `N8NIdentifier.resolve`

Pinned signature shape:

```ts
resolve(
  credentialContext: ICredentialContext,
  configuration: Record<string, unknown>,
): Promise<string>;
```

Pinned manual behavior:

1. For:

```ts
{
  version: 1,
  identity: n8nAuthCookie,
  metadata: { source: 'manual-execution' },
}
```

2. Call the real `AuthService.authenticateUserByCookie(identity)`.
3. Return the authenticated user’s `id`.
4. Correctly distinguish different users’ cookies.
5. Honor the invalid-token blocklist and MFA checks performed by `AuthService`.
6. A blocklisted cookie rejects with:

```text
Unauthorized
```

7. It must not require the original request, browser id, endpoint, or HTTP method. The cookie was captured at the controller boundary and is revalidated later.

Required integration, but not directly covered by the named manual test:

- `buildTriggerIdentityCredentials(token, resource)` creates metadata:

```ts
{ source: 'n8n-oauth', resource }
```

- The system resolver must be able to map that bearer-token context to an n8n user, most plausibly through `OAuthTokenVerifierProxy.verifyOAuthAccessToken(identity, resource)`.
- The exact failure mapping and message for bearer-token verification need new clean-room tests.

### Resolution provider contract

`DynamicCredentialsProxy` requires a provider with:

```ts
resolveIfNeeded(
  metadata: {
    id: string;
    name: string;
    type: string;
    resolverId?: string;
    isResolvable: boolean;
  },
  staticData: ICredentialDataDecryptedObject,
  executionContext?: IExecutionContext,
  workflowSettings?: IWorkflowSettings,
): Promise<{
  data: ICredentialDataDecryptedObject;
  isDynamic: boolean;
  resolvedUserId?: string;
}>;

getSystemResolverId(): string | null;
```

Resolver precedence on the surviving write path is:

```text
credential.resolverId
→ workflow.settings.credentialResolverId
→ seeded system resolver
```

Core expectations:

- Fixed credentials return static data with `isDynamic: false`.
- Resolvable credentials determine an identity from the decrypted execution context.
- The system resolver maps identity to an n8n user and uses `DynamicCredentialUserEntryStorage`.
- A custom resolver maps identity to a general subject and uses `DynamicCredentialEntryStorage`.
- Successful system resolution should return `resolvedUserId`; external-subject resolvers leave it undefined.
- The exact static/dynamic merge rule and encryption envelope are under-pinned.
- `resolvableAllowFallback` semantics are under-pinned. It is not present in `CredentialResolveMetadata`, so the service would need to query the credential entity if it implements fallback.

Proxy behavior without a registered provider is already exact:

- Fixed credential: return static data.
- Resolvable credential warning:

```text
No dynamic credential resolving provider set, but trying to resolve resolvable credential "<name>"
```

- Then throw:

```text
No dynamic credential resolving provider set
```

Equivalent storage behavior:

```text
No dynamic credential storage provider set, but trying to store resolvable credential "<name>"
```

followed by:

```text
No dynamic credential storage provider set
```

Source: [dynamic proxy](/home/ggrace/linux-coding/n8n/packages/cli/src/credentials/dynamic-credentials-proxy.ts:1), [execution-context schema](/home/ggrace/linux-coding/n8n/packages/workflow/src/execution-context.ts:56), [manual integration spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/manual-execution-credential-context.test.ts:1).

## 6. Resolvable-credentials REST surface

These are existing `/credentials` routes augmented by the module/provider. The named spec does not cover dedicated `/credential-resolvers` or external execution-status endpoints.

### Routes

| Route | Request | Success | Required scope/gate | Pinned dynamic effect |
|---|---|---:|---|---|
| `GET /credentials` | normal list query | 200 | User-filtered service; no route-level scope decorator | Add `connectedByMe` only to resolvable credentials; use one bulk query |
| `GET /credentials/for-workflow?projectId=:id` | query requires `projectId` or `workflowId` | 200 | Access determined by workflow/project credential lookup | Same per-user `connectedByMe`; omit it for fixed credentials |
| `GET /credentials/:id?includeData=true` | query | 200 | `credential:read` | Add `connectedByMe`, `connectedUserCount`; expose `data.oauthTokenData = true` only when current user is connected |
| `POST /credentials` | `{ name, type, data, projectId?, isResolvable? }` | 200 | `credential:create`; additionally `credential:createEndUser` when resolvable | Role-restricted creation |
| `PATCH /credentials/:id` | full or partial credential body; tests send `{ name, type, data, isResolvable }` | 200 | `credential:update`; additionally `credential:createEndUser` only when toggling fixed/private | Clear shared OAuth data or per-user rows as applicable |
| `PUT /credentials/:id/share` | `{ shareWithIds: string[] }` | 200 | `feat:sharing`; `credential:share` for additions, `credential:unshare` for removals | Resolvable credentials may be shared/unshared |
| `PUT /credentials/:id/transfer` | `{ destinationProjectId: string }` | 200 | `credential:move`, destination `credential:create`; resolvable transfer additionally needs destination `credential:createEndUser` | Reconcile connections after ownership move |
| `DELETE /credentials/:id` | no body | 200 | `credential:delete`; resolvable credential additionally needs owning-project `credential:createEndUser` | Delete credential; entry tables cascade |

### Response enrichment

For resolvable credentials:

- `connectedByMe: true` iff the current user has a row under `SYSTEM_RESOLVER_ID`.
- Otherwise `connectedByMe: false`.
- `connectedUserCount` is the number of distinct connected users under the system resolver.
- When `includeData=true`:
  - connected user receives `data.oauthTokenData = true`;
  - disconnected user receives no `oauthTokenData` property.

For fixed credentials:

- omit `connectedByMe`;
- omit `connectedUserCount`;
- preserve existing shared OAuth behavior: all authorized readers see `data.oauthTokenData = true` when shared token data exists.

### Toggle behavior

Fixed → end-user:

- Set `isResolvable = true`.
- Remove `oauthTokenData` from the shared encrypted credential blob.
- Absence of OAuth data is a valid no-op.

End-user → fixed:

- Set `isResolvable = false`.
- Delete all per-user entries for that credential in the same database transaction as the credential update.
- No rows is a valid no-op.

While remaining end-user:

- Compare only credential properties where `resolvableField !== true`.
- Any changed shared field invalidates all per-user connections.
- Comparison uses deep `lodash/isEqual`.
- Unknown credential type or decrypt failure returns `[]` and leaves connections untouched rather than blocking the update.

### Sharing and transfer

A credential shared with role `credential:user` grants:

```text
credential:read
credential:connect
```

and does not grant:

```text
credential:update
```

Unsharing must clean up connections belonging to users who lose `credential:connect`.

Transfer must:

- remove connections for source-project members who have no access in the destination;
- retain users who have destination-project access;
- retain users whose global role still grants access.

The current surviving `EnterpriseCredentialsService.transferOne()` does not perform this reconciliation or the resolvable destination permission check. That is a concrete integration gap the rebuild must close.

### Role matrix pinned by the spec

| Actor/action | Result |
|---|---:|
| Team-project editor creates end-user credential | 403 |
| Team-project editor creates fixed credential | 200 |
| Project admin creates end-user credential | 200 |
| Instance admin creates end-user credential without project membership | 200 |
| Member creates end-user credential in personal project | 200 |
| Editor toggles team credential fixed → end-user | 403 |
| Editor toggles team credential end-user → fixed | 403 |
| Project admin performs either toggle | 200 |
| Editor updates an end-user credential without changing `isResolvable` | 200 |
| Editor transfers personal end-user credential into a team project where they are editor | 403 |
| Project admin transfers end-user credential into their team | 200 |
| Editor transfers fixed credential into team | 200 |
| Editor deletes team end-user credential | 403 |
| Editor deletes team fixed credential | 200 |
| Project admin deletes team end-user credential | 200 |

The controlling scope is:

```text
credential:createEndUser
```

Default grants:

- global owner/admin: yes;
- personal-project owner: yes;
- project admin: yes;
- project editor/viewer: no;
- `credential:owner` sharing role: yes;
- `credential:user` sharing role: no.

### License behavior

The acceptance server enables both:

```text
feat:sharing
feat:dynamicCredentials
```

Only sharing has a surviving explicit route decorator. The exact response when `feat:dynamicCredentials` is unlicensed is not pinned. Do not assume whether the core credential routes reject `isResolvable`, ignore it, or rely solely on the module not initializing; add a clean-room acceptance test.

### Verbatim messages

The REST acceptance spec asserts statuses and response fields, not error bodies. Therefore no message is literally acceptance-pinned by that file.

Surviving core implementation currently emits:

```text
You do not have permission to manage end-user credentials in this project
```

Other relevant exact strings are:

```text
Credential to be updated not found. You can only update credentials owned by you
Managed credentials cannot be updated
Credential ID "<id>" could not be found to be updated.
You are not licensed for sharing credentials
Credential to be deleted not found. You can only removed credentials owned by you
```

The deletion message’s `removed` grammar is the surviving verbatim text, not a correction.

Source: [REST acceptance spec](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/credentials/credentials.resolvable.api.test.ts:1), [credentials controller](/home/ggrace/linux-coding/n8n/packages/cli/src/credentials/credentials.controller.ts:70), [permission scope](/home/ggrace/linux-coding/n8n/packages/@n8n/permissions/src/scope-information.ts:101).

## 7. Credentials subsystem and execution integration

### `CredentialsHelper.getDecrypted`

Resolution is mode-sensitive:

1. Load the credential entity and decrypt its shared/static data.
2. Compute `effectiveMode = rootExecutionMode ?? mode`.
3. In `manual` or `internal` mode:
   - no credential context: skip dynamic resolution and use static data;
   - credential context present: resolve.
4. In every other mode:
   - always call the resolution provider, including when execution context or credentials are absent;
   - this prevents production runs from silently falling back.
5. Pass metadata:

```ts
{
  id,
  name,
  type,
  isResolvable,
  resolverId: resolverId ?? undefined,
}
```

plus static data, execution context, and workflow settings.

When resolution returns `isDynamic: true`:

```ts
additionalData.currentNodeUsedDynamicCredentials = true;
additionalData.dynamicCredentialsResolvedUserId = result.resolvedUserId;
```

Before attempting a resolvable credential:

```ts
additionalData.currentNodeAttemptedDynamicCredentials = true;
```

The production unresolved error class is `CredentialResolutionError`; its acceptance-pinned text is:

```text
This node uses an end-user credential, but no user could be identified for this run, so the credential for it couldn't be resolved
```

The named tests explicitly require no static fallback in non-manual mode when context or identity is missing.

### OAuth token refresh/write path

`updateCredentialsOauthTokenData()` selects:

```text
credential.resolverId
→ workflow resolver
→ system resolver
```

It writes dynamically only when all are true:

- `isResolvable`;
- effective resolver id exists;
- `executionContext.credentials` exists.

Otherwise it preserves the existing fixed-credential behavior and stores OAuth data in the shared encrypted credential row.

`DynamicCredentialsProxy.storeOAuthTokenDataIfNeeded()`:

- returns immediately for non-resolvable credentials or absent `resolverId`;
- decrypts `executionContext.credentials`;
- validates it with `toCredentialContext`;
- delegates `{ oauthTokenData }` to storage;
- throws this exact error when context is unavailable:

```text
No credential context found
```

with diagnostic extras `credentialId` and `credentialName`.

### Initial OAuth authorization/callback

For a resolvable credential, normal browser authorization:

- requires `credential:connect`, rather than `credential:update`;
- obtains the system resolver id;
- captures the current auth cookie;
- stores state:

```ts
{
  cid,
  origin: 'dynamic-credential',
  userId,
  credentialResolverId,
  authorizationHeader: `Bearer ${cookieToken}`,
  authMetadata: { source: 'manual-execution' },
}
```

OAuth1 and OAuth2 callbacks:

- accept `origin === 'dynamic-credential'`;
- validate user id when both request and state carry one;
- allow externally initiated flows with no state user id;
- require:

```text
Credential resolver ID is required
Authorization header is required
```

- store OAuth data through `DynamicCredentialsProxy`, not in the shared credential blob;
- emit `private-credential-user-connected` when a user id is present.

### Manual execution identity lifecycle

`WorkflowExecutionService.executeManually(...)` receives the n8n auth cookie and calls:

```ts
ExecutionContextService.buildManualExecutionCredentials(cookie)
```

which encrypts:

```ts
{
  version: 1,
  identity: cookie,
  metadata: { source: 'manual-execution' },
}
```

The encrypted string is persisted in `runtimeData.credentials`. It must differ from the plaintext cookie.

If no cookie is supplied:

- execution source remains `manual`;
- `runtimeData.credentials` is undefined.

Queue-mode propagation is also required:

- workflow runner copies `encryptedRunnerIdentity` into job data;
- the worker/job processor restores it into execution additional data;
- sub-workflows inherit the parent context;
- the credential resolver decrypts only at point of use.

### Workflow and webhook integration

`IWorkflowSettings` has:

```ts
credentialResolverId?: string;
```

The effective workflow resolver is the explicit setting or the system resolver.

`WorkflowRepository` provides:

```ts
findByCredentialResolverId(resolverId)
findActiveByCredentialResolverId(resolverId)
clearCredentialResolverId(resolverId, trx?)
```

for resolver UI warnings, active-workflow checks, and deletion cleanup.

Publishing a workflow with resolvable credentials validates trigger identity capabilities:

- system resolver requires every trigger to provide n8n identity;
- custom resolver requires every trigger to provide external identity;
- missing resolver blocks publishing;
- incompatible triggers block publishing.

Webhook/MCP execution can call:

```ts
checkCredentialStatus(workflowId, executionContext)
```

through module context before execution. The response schema is:

```ts
{
  workflowId: string;
  credentials?: Array<{
    credentialId: string;
    credentialName: string;
    credentialType: string;
    credentialStatus: 'missing' | 'configured' | 'resolver_missing';
    authorizationUrl?: string;
    revokeUrl?: string;
  }>;
  readyToExecute: boolean;
}
```

### Other surviving consumer obligations

The rebuild must remain compatible with:

- telemetry reporting license state, resolver selection, attempted/used private credentials;
- redaction based on `usedDynamicCredentials`;
- propagation of private-credential use from sub-executions;
- setting `runtimeData.executedByUserId` for a resolved n8n user;
- source-control/import/public-API serialization of `isResolvable`, `resolvableAllowFallback`, and `resolverId`;
- public workflow APIs stripping `credentialResolverId` as an internal setting;
- trigger classification in `n8n-workflow`;
- `INodeProperties.resolvableField`, which distinguishes per-identity fields from shared configuration.

Sources: [credentials helper](/home/ggrace/linux-coding/n8n/packages/cli/src/credentials-helper.ts:515), [execution-context service](/home/ggrace/linux-coding/n8n/packages/core/src/execution-engine/execution-context.service.ts:21), [workflow validation](/home/ggrace/linux-coding/n8n/packages/cli/src/workflows/workflow-validation.service.ts:300), [workflow interfaces](/home/ggrace/linux-coding/n8n/packages/workflow/src/interfaces.ts:1170).

## 8. `DynamicCredentialsConfig`

The acceptance setup requires an injectable class with these fields:

```ts
class DynamicCredentialsConfig {
  endpointAuthToken: string;
  corsOrigin: string;
  corsAllowCredentials: boolean;
}
```

The spec supplies:

```ts
{
  endpointAuthToken: 'static-test-token',
  corsOrigin: 'https://app.example.com',
  corsAllowCredentials: false,
}
```

What is actually pinned:

- field names;
- primitive types;
- DI constructability/mockability.

Surviving Playwright configuration establishes one environment variable:

```text
N8N_DYNAMIC_CREDENTIALS_ENDPOINT_AUTH_TOKEN
```

The global feature opt-in is separately:

```text
N8N_ENV_FEAT_DYNAMIC_CREDENTIALS=true
```

That feature flag:

- allows dynamic-credential tests/module behavior;
- loads the `dynamicCredentialCheck` node;
- injects trigger context-establishment hooks.

Not pinned:

- config defaults;
- environment variable names for `corsOrigin` and `corsAllowCredentials`;
- whether an empty token disables external endpoints;
- allowed-origin matching;
- preflight behavior;
- `Access-Control-Allow-Credentials` behavior;
- interaction between the environment flag and license flag.

Do not guess the two CORS environment variable names without adding a clean-room config test.

## 9. Explicitly open or under-pinned areas

These areas cannot be reconstructed exactly from the named gates:

1. **System resolver name and type.** The exports are required, but only id `'system-n8n'` survives with a value.
2. **Resolver CRUD authorization.** Available scopes are:

```text
credentialResolver:create
credentialResolver:read
credentialResolver:update
credentialResolver:delete
credentialResolver:list
```

Conventional mapping is obvious, but the missing controller means exact decorators and project/global scoping are not pinned.
3. **Dedicated resolver routes.** Frontend consumers require:
   - `GET /credential-resolvers`
   - `GET /credential-resolvers/types`
   - `GET /credential-resolvers/:id`
   - `POST /credential-resolvers`
   - `PATCH /credential-resolvers/:id`
   - `GET /credential-resolvers/:id/workflows`
   - `DELETE /credential-resolvers/:id`

   Request DTOs and response schemas survive, but statuses, errors, system-resolver protection, uniqueness, ordering, and deletion policy need tests.
4. **External execution endpoints.** Surviving consumers require:
   - `GET /workflows/:id/execution-status`
   - `POST /credentials/:id/authorize`
   - `GET /credentials/:id/authorize?token=...`
   - `DELETE /credentials/:id/revoke`

   Their full authentication, CORS, static-token, status, and error contracts are outside the named gates.
5. **Custom resolver implementation.** A surviving E2E consumer mentions type `credential-resolver.oauth2-1.0` with `metadataUri` and `validation: 'oauth2-userinfo'`, but the named 5,357-line gate set does not pin its validation algorithm, retries, timeout, issuer/audience checks, or failure text.
6. **Resolver config encryption.** The database requires encrypted text and API responses distinguish `config` from optional `decryptedConfig`; the exact cipher usage and redaction rules are not specified.
7. **Dynamic entry encryption format.** Storage treats `data` as opaque text. Merge/encryption formats must be designed clean-room.
8. **`resolvableAllowFallback`.** Schema and default survive, but no named test defines when fallback is allowed, which failures qualify, or whether fallback should be reported as dynamic.
9. **Concurrency behavior.** Storage upsert is required, but the SQL strategy, timestamp changes, locking, and last-writer semantics are not pinned.
10. **Repository ordering.** No ordering is asserted anywhere; do not introduce an API guarantee accidentally.
11. **Resolver CRUD uniqueness.** Neither DB nor DTOs enforce unique names/types.
12. **Length mismatch.** API resolver ids allow 36 characters and names/types allow 255, while the database allows 16/128/128. The rebuild must reconcile this deliberately; simply using the API maximums will produce DB failures.
13. **Resolver deletion rules.** DB cascades entries and nulls credential resolver ids. Workflow cleanup methods survive, but whether active workflows block deletion, whether deletion always clears settings, and whether system resolver deletion is forbidden need tests.
14. **`clearCredentials` update behavior.** `UpdateCredentialResolverDto` exposes `clearCredentials?: boolean`, but the exact tables affected and transaction behavior are not pinned.
15. **Module process and flag policy.** Runtime consumers prove workers/webhooks need providers; the exact `BackendModule` `instanceTypes`, license decorator, and environment gating need a clean-room decision.
16. **Credential-specific resolver precedence during reads.** The write path clearly prefers credential → workflow → system. Read resolution almost certainly must match, but this exact precedence is not directly asserted by the named tests.
17. **Transfer integration is incomplete today.** The acceptance contract requires `credential:createEndUser` in the destination and connection reconciliation; surviving `transferOne()` currently performs neither.
18. **Stale `.ee` imports.** All named specs currently import removed `.ee` paths. A fair-code rebuild must update them to the normal module path; recreating those paths would violate the fork policy.

Verification performed: all named files were re-counted at 5,357 lines, the exact strings and surviving system id were re-grepped, and `git status --short --branch` showed no worktree changes. No tests were run because this was a read-only contract extraction and the gates currently cannot compile until the missing fair-code module and stale imports are addressed.