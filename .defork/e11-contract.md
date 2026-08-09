# Clean-room provisioning rebuild contract

The surviving module is only a main-process registration marker plus a read-only cached configuration loader. The rule engine, controllers, persistence operations, reconciliation, reload wiring, and role-deletion integration must be rebuilt from the fair-code contracts below. No Enterprise source or history was accessed.

I distinguish:

- **Pinned** — directly asserted by surviving tests or production code.
- **Required** — necessary to satisfy those pins.
- **Open** — not sufficiently specified; needs an explicit decision and tests.

## 1. Module file map and required exports

| Surface | What exists | What consumers require |
|---|---|---|
| [constants.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/provisioning/constants.ts:2) | `PROVISIONING_PREFERENCES_DB_KEY = 'sso.provisioning.config'` | Keep this as the single settings-key authority. |
| [provisioning.module.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/provisioning/provisioning.module.ts:9) | `ProvisioningModule`, registered as `name: 'provisioning'`, `instanceTypes: ['main']`; empty `init()` | Import/register both controllers, initialize the service, instantiate its pubsub handler, and register the role-deletion checker. |
| [provisioning.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/provisioning/provisioning.service.ts:16) | Cached config read, reload, and two simple “managed” queries | Config mutation, policy evaluation, role resolution/reconciliation, idempotent initialization, and expression-rule-aware managed-state checks. |
| Provisioning config controller | Missing | `GET/PATCH /sso/provisioning/config`. |
| Role-mapping-rule controller/service | Missing | Complete `/role-mapping-rule` CRUD/move API. |
| Expression evaluator facade | Missing | Isolated evaluation against claims/provider context. |
| Role deletion checker | Missing | Implements `RoleDeletionCheckProvider`; blocks deletion of referenced/default roles. |

The module’s main-only metadata is pinned by [main-only-modules.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/__tests__/main-only-modules.test.ts:15).

Several tests still import purged `.ee` paths. In particular, the integration test server still dispatches endpoint groups to missing controllers at [test-server.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/shared/utils/test-server.ts:325). The clean rebuild must migrate these imports completely to fair-code paths; it should not create `.ee` compatibility files.

Required public classes/values:

```ts
export const PROVISIONING_PREFERENCES_DB_KEY: string;
export class ProvisioningModule;
export class ProvisioningService;
export class ProvisioningController;
export class RoleMappingRuleController;
export class ProvisioningRoleDeletionChecker implements RoleDeletionCheckProvider;
```

A separate `RoleMappingRuleService` and provisioning expression-evaluator class are recommended, even though their exact names are not pinned.

## 2. `ProvisioningService` full contract

### Existing behavior

`getProvisioningConfig()` currently:

1. Returns the cached value when present.
2. Builds disabled defaults:
   - all three provisioning flags `false`;
   - claim/scope names from `GlobalConfig.sso.provisioning`.
3. Reads `sso.provisioning.config`.
4. Returns disabled defaults if the row is missing.
5. JSON-parses and validates the entire `ProvisioningConfigDto`.
6. Rejects partial or invalid stored shapes by silently using disabled defaults.
7. Logs a warning only for JSON/parsing exceptions.

See [provisioning.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/provisioning/provisioning.service.ts:25).

`handleReloadSsoProvisioningConfiguration()` clears the cache and eagerly reloads it.

### Required service surface

```ts
init(): Promise<void>;
getProvisioningConfig(): Promise<ProvisioningConfigDto>;
updateProvisioningConfig(
  patch: ProvisioningConfigPatchDto,
  actor: User,
): Promise<ProvisioningConfigDto>;
handleReloadSsoProvisioningConfiguration(): Promise<void>;

isInstanceRoleManaged(): Promise<boolean>;
isProjectRoleManaged(): Promise<boolean>;

resolveLoginProvisioning(input: ProvisioningEvaluationInput):
  Promise<ProvisioningDecision>;

applyLoginProvisioning(
  user: User,
  decision: ProvisioningDecision,
  context: OperationContext,
): Promise<ProvisioningApplicationResult>;
```

`init()` is explicitly called by the SAML integration spec at [saml.api.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/saml/saml.api.test.ts:927). It should be idempotent and at minimum load the initial config. The module should call it during module initialization.

Older tests also call `getConfig()` and mutate a private `provisioningConfig` slot in [project.api.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/project.api.test.ts:355) and [users.api.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/users.api.test.ts:1741). Those are test-era implementation dependencies, not a good new public API. The clean migration should update them to the surviving `getProvisioningConfig()` API and controlled test setup rather than add aliases/private mutability.

### Config update semantics

Pinned by the DTO and API spec:

- PATCH is partial.
- `defaultInstanceRole: null` removes the property.
- Persist the merged, full `ProvisioningConfigDto`, because the reader rejects partial rows.
- Allowed `defaultInstanceRole`:
  - `block:access`;
  - an existing assignable global role such as `global:admin`.
- Reject with 400:
  - `global:owner`;
  - nonexistent roles;
  - non-global roles such as `project:editor`.
- `deleteProjectRules: true` deletes every project-type mapping rule and compacts/clears their order space.
- After persistence, update the local cache and publish a reload command to other main processes.

The other nullable fields do not have pinned reset semantics. Resetting nullable claim/scope names to their `GlobalConfig` defaults is sensible, but requires tests before implementation.

### Managed-role semantics

The current methods only check direct-claim flags and therefore under-report managed roles.

Pinned behavior is:

```ts
instanceRolesManaged =
  config.scopesProvisionInstanceRole ||
  (
    config.scopesUseExpressionMapping &&
    existsRule({ type: 'instance' })
  );

projectRolesManaged =
  config.scopesProvisionProjectRoles ||
  (
    config.scopesUseExpressionMapping &&
    existsRule({ type: 'project' })
  );
```

Expression mapping only locks manual changes when the corresponding rule type exists. This is pinned by [project.api.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/project.api.test.ts:384) and [users.api.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/users.api.test.ts:1764).

Consumers depend on these answers to deny manual role changes:

- [users.controller.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/controllers/users.controller.ts:338)
- [project.controller.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/controllers/project.controller.ts:279)
- [public projects handler](/home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/handlers/projects/projects.handler.ts:47)

### Rule persistence and ordering

The entity persists:

```ts
{
  id: string;             // varchar(16)
  expression: string;     // text
  role: Role;             // FK to role.slug
  type: string;           // intended: instance | project
  order: number;
  projects: Project[];    // many-to-many
  createdAt;
  updatedAt;
}
```

See [RoleMappingRule](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/entities/role-mapping-rule.ts:17).

The migration explicitly states “first match wins” within each rule type and enforces `UNIQUE(type, order)` at [CreateRoleMappingRuleTable](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1772800000000-CreateRoleMappingRuleTable.ts:6). Role and project links cascade on deletion.

The surviving [repository](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/repositories/role-mapping-rule.repository.ts:7) is otherwise bare. Use-case-named transaction-aware methods must be added; controller/business code must not manipulate TypeORM ordering directly.

## 3. Evaluation engine contract

### Inputs

A common provider-neutral input should preserve both direct-role claims and raw expression inputs:

```ts
interface ProvisioningEvaluationInput {
  provider: 'saml' | 'oidc';
  claims: Record<string, unknown>;
  providerContext:
    | {
        provider: 'saml';
        rawAttributes: Record<string, unknown>;
      }
    | {
        provider: 'oidc';
        idToken: Record<string, unknown>;
        userInfo: Record<string, unknown>;
      };
  directClaims?: {
    instanceRole?: string;
    projectRoles?: string[];
  };
}
```

Expression context:

```ts
// SAML
{
  $claims: rawAttributes,
  $provider: 'saml',
}

// OIDC
{
  $claims,
  $oidc: { idToken, userInfo },
  $provider: 'oidc',
}
```

SAML’s raw `$claims` and provider discriminator are pinned by the integration spec and clean-room contract. OIDC’s intended context is recorded at [.defork/e5e6-contract.md](/home/ggrace/linux-coding/n8n/.defork/e5e6-contract.md:532) and [DEFORK_CHANGELOG.md](/home/ggrace/linux-coding/n8n/DEFORK_CHANGELOG.md:220), but `$claims` precedence between ID-token and UserInfo values remains open.

### Verbatim SAML pins

The full provisioning block is [saml.api.test.ts lines 915–1118](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/saml/saml.api.test.ts:915).

It pins these exact behaviors:

- `should provision instance role via expression mapping`
  - Expression: `{{ $claims.department === 'it' }}`
  - Matching raw claim assigns `global:admin`.
- `should deny the login and create no account when no rule matches and the default condition is block access`
  - Nonmatching rule plus `block:access` rejects with `ForbiddenError`.
  - No user row may be created.
- `should deny an existing user without touching their account when the default condition is block access`
  - Rejects with `ForbiddenError`.
  - Existing role remains `global:member`.
  - `disabled` remains `false`.
- `should log in with the mapped role when a rule matches even though the default condition is block access`
  - A matching rule takes precedence over the default denial.
- `should provision project role via expression mapping`
  - Expression: `{{ $claims.groups !== undefined && $claims.groups.includes('n8n-editors') }}`
  - Assigns `project:editor` to the rule’s linked project.

The test calls `SamlService` directly, so it pins the exception class, not an HTTP response body or exact message. `ForbiddenError` represents the access-denial outcome; the current temporary fail-closed message is not the rebuilt engine’s required message.

### Rule resolution

Pinned algorithm:

1. Fetch rules by `type` and ascending `order`.
2. Evaluate expressions against the provider context.
3. First matching instance rule supplies the instance role.
4. A matching rule wins over `defaultInstanceRole`.
5. If no instance rule matches:
   - explicit role slug → assign that role;
   - `block:access` → deny;
   - unset + expression mapping → legacy `global:member`;
   - unset + direct-claim provisioning → skip instance-role mutation.
6. Project expressions assign their configured project role to their linked projects.
7. With no project match, the UI contract says: “no project access given.”

The default behavior is documented in [ProvisioningConfigDto](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/provisioning/config.dto.ts:12). “First matching rule wins” and the project default wording survive in [en.json](/home/ggrace/linux-coding/n8n/packages/frontend/@n8n/i18n/src/locales/en.json:5606).

### Decision and mutation ordering

Recommended decision type:

```ts
type ProvisioningDecision =
  | { outcome: 'deny'; reason: 'block-access' | 'evaluation-failed' }
  | {
      outcome: 'allow';
      instanceRole?: ResolvedInstanceRole;
      projectRoles: ResolvedProjectRole[];
      removedProjectIds: string[];
    };
```

Required sequence:

```text
validate provider response
→ evaluate all provisioning policy
→ if denied, stop before account lookup or mutation
→ resolve/create user
→ transactionally apply instance role and project relations
→ commit
→ emit relay/audit/telemetry events
```

Denial-before-mutation is a hard requirement for both new and existing accounts.

Project reconciliation must not use `ProjectService.syncProjectRelations()`, which replaces an entire project’s relation set. It needs user-oriented repository operations, preserving personal-project ownership and unrelated users.

## 4. Controller routes

### Provisioning configuration

| Route | Scope/status contract |
|---|---|
| `GET /sso/provisioning/config` | Returns `{ data: ProvisioningConfigDto }`. Authentication/license and exact scope are not independently pinned; `provisioning:manage` is the consistent required scope. |
| `PATCH /sso/provisioning/config` | Requires `provisioning:manage`; missing scope is 403. Returns merged config in `data`. |

The full executable config spec is [provisioning-config.api.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/provisioning-config.api.test.ts:30).

PATCH status pins:

- Valid `block:access`: 200, persisted and returned by subsequent GET.
- Valid `global:admin`: 200.
- `global:owner`: 400.
- Nonexistent global role: 400.
- Project role: 400.
- `defaultInstanceRole: null`: 200 and property absent afterward.
- Missing `provisioning:manage`: 403.

After a successful PATCH, call `handleReloadSsoProvisioningConfiguration()` locally and distribute `reload-sso-provisioning-configuration`.

### Role mapping rules

DTOs are defined in:

- [CreateRoleMappingRuleDto](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/roles/create-role-mapping-rule.dto.ts:5)
- [PatchRoleMappingRuleDto](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/roles/patch-role-mapping-rule.dto.ts:5)
- [MoveRoleMappingRuleDto](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/roles/move-role-mapping-rule.dto.ts:5)
- [ListRoleMappingRuleQueryDto](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/roles/list-role-mapping-rule-query.dto.ts:10)

| Route | Required scope | Pinned behavior |
|---|---|---|
| `POST /role-mapping-rule` | `roleMappingRule:create` | Insert at requested position and shift same-type rules; omitted order appends; high order clamps. |
| `GET /role-mapping-rule` | `roleMappingRule:list` | `{ count, items }`; default `order:asc`; type filter; pagination; allowed sort fields only. |
| `PATCH /role-mapping-rule/:id` | `roleMappingRule:update` | Update fields; high order clamps; collision with an occupied same-type order returns 409. |
| `POST /role-mapping-rule/:id/move` | `roleMappingRule:update` | Reorders and compacts; high target clamps; negative target is 400. |
| `DELETE /role-mapping-rule/:id` | `roleMappingRule:delete` | Deletes and compacts remaining same-type orders; returns success. |

Common status pins from [role-mapping-rule.api.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/role-mapping-rule.api.test.ts:41):

- Unauthenticated: 401.
- Missing operation scope: 403.
- Neither SAML nor OIDC licensed: 403 with exact body:

```json
{ "message": "Provisioning is not licensed" }
```

- Invalid DTO: 400.
- Missing rule: 404.
- Missing role: 404 with message containing `Could not find role`.
- Project rule without `projectIds`: 400 with message containing `projectIds`.
- Instance and project rules may both use order zero because ordering is type-local.
- Response item fields: `id`, `expression`, `role`, `type`, `order`, `projectIds`, `createdAt`, `updatedAt`.

Provisioning is licensed if either `feat:saml` or `feat:oidc` is available, per [LicenseState.isProvisioningLicensed()](/home/ggrace/linux-coding/n8n/packages/@n8n/backend-common/src/license-state.ts:209).

## 5. Settings-key resolution

**Authoritative key: `sso.provisioning.config`.**

Evidence:

1. The production constant defines it at [constants.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/provisioning/constants.ts:2).
2. The production loader writes through that constant at [provisioning.instance-settings-loader.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/instance-settings-loader/loaders/sso/provisioning.instance-settings-loader.ts:58).
3. `ProvisioningService` reads through the same constant.
4. The OIDC integration cleanup uses the same constant at [oidc.instance-settings-loader.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/oidc/oidc.instance-settings-loader.test.ts:38).
5. `features.provisioning` occurs only in three stale unit-test expectations.

Empirical verification:

```text
7 tests collected
4 passed
3 failed
```

All three failures show exactly:

```diff
- "key": "features.provisioning"
+ "key": "sso.provisioning.config"
```

Therefore the production key is authoritative and the three test literals must change. There is no surviving evidence requiring a legacy `features.provisioning` fallback or migration.

The environment loader supports only:

- `disabled`
- `instance_role`
- `instance_and_project_roles`

Although the shared `ProvisioningMode` also declares `expression_based`. Environment-loaded config always sets expression mapping to false.

## 6. SAML and OIDC integration points

### SAML

Current flow in [saml.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-saml/saml.service.ts:391):

```ts
const { mapped } = await getAttributesFromLoginResponse(...);
validateEmail();
await assertProvisioningPolicyCanBeApplied(); // temporary deny gate
const user = await userRepository.findOne(...);
```

Problems to replace:

- `getAttributesFromLoginResponse()` already returns `{ mapped, raw }`, but `handleSamlLogin()` discards `raw`.
- The temporary gate at [line 459](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-saml/saml.service.ts:459) denies any configured policy or any stored rule.
- Exact current exception:

```ts
new ForbiddenError(
  'SAML login failed: the role provisioning policy cannot be applied',
);
```

Replacement call site:

```ts
const { mapped, raw } = await this.getAttributesFromLoginResponse(...);
validateEmail();

const decision = await provisioningService.resolveLoginProvisioning({
  provider: 'saml',
  claims: raw,
  providerContext: { provider: 'saml', rawAttributes: raw },
  directClaims: {
    instanceRole: mapped.n8nInstanceRole,
    projectRoles: mapped.n8nProjectRoles,
  },
});
```

This evaluation must remain before `userRepository.findOne()` and every write.

Direct claim names are already selected from persisted config at [saml.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-saml/saml.service.ts:616).

### OIDC

Current flow in [oidc.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-oidc/oidc.service.ts:691):

```ts
await assertProvisioningPolicyIsEvaluable();
const config = await loadConfig();
const identity = resolveIdentityClaims(claims, userInfo);
```

The gate denies if any config flag is enabled or any default is defined. It throws:

```ts
new AuthError('OIDC login failed')
```

The unit spec pins that it runs before all identity/user repository lookup or mutation at [oidc.service.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-oidc/__tests__/oidc.service.test.ts:873).

Replacement:

```ts
const decision = await provisioningService.resolveLoginProvisioning({
  provider: 'oidc',
  claims: canonicalClaims,
  providerContext: {
    provider: 'oidc',
    idToken: claims,
    userInfo,
  },
  directClaims: extractConfiguredOidcRoleClaims(...),
});
```

OIDC currently has no `RoleMappingRuleRepository` dependency, so unlike SAML its fail-closed gate does not detect stray rules when all config flags are false. Centralizing evaluation in `ProvisioningService` removes this divergence.

A second mismatch exists in [buildScopes()](/home/ggrace/linux-coding/n8n/packages/cli/src/modules/sso-oidc/oidc.service.ts:480): it consults `GlobalConfig.sso.provisioning`, while runtime policy consults persisted provisioning config. Scope generation and policy evaluation must use one effective configuration source, or API changes can enable a claim without requesting its OIDC scope.

## 7. Events, pubsub, and telemetry

### Pubsub

The event map reserves:

```text
reload-sso-provisioning-configuration
```

at [pubsub.event-map.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/pubsub/pubsub.event-map.ts:33).

Current defects:

- `handleReloadSsoProvisioningConfiguration()` has no `@OnPubSubEvent`.
- No surviving code publishes the command.

Required:

- Decorate/register the handler for main instances.
- Publish after successful config persistence.
- Ensure module initialization instantiates the handler-bearing service.

### Provisioning result events

Pinned event shapes are in [relay.event-map.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/events/maps/relay.event-map.ts:853):

- `sso-user-project-access-updated`
  - `projectsRemoved`, `projectsAdded`, `userId`
- `sso-user-instance-role-updated`
  - `role`, `userId`
- `expression-mapping-roles-resolved`
  - provider;
  - previous/resolved instance role;
  - changed/fallback state;
  - matched rule and expression;
  - project assignments;
  - `removedProjectIds`.

Telemetry names are exactly:

- `Sso user project access update`
- `Sso user instance role update`

The expression result becomes audit event:

```text
n8n.audit.role-mapping.roles-resolved
```

### Rule-management events

Emit:

- `role-mapping-rule-created`
- `role-mapping-rule-updated`
- `role-mapping-rule-deleted`
- `role-mapping-rules-bulk-deleted`

The bulk event has:

```ts
{
  ruleType: 'instance' | 'project',
  count: number,
  reason: 'strategy-switch',
}
```

Log streaming maps these to `n8n.audit.role-mapping.rule.*` audit events.

The frontend separately emits `User updated provisioning settings` with assignment method, mapping method, and instance/project rule counts at [useUserRoleProvisioningForm.ts](/home/ggrace/linux-coding/n8n/packages/frontend/editor-ui/src/features/settings/sso/provisioning/composables/useUserRoleProvisioningForm.ts:122).

## 8. Expression-evaluation recommendation and risks

Use `@n8n/expression-runtime` with:

- `ExpressionEvaluator`
- `IsolatedVmBridge`
- production AST hooks:
  - `ThisSanitizer`
  - `PrototypeSanitizer`
  - `DollarSignValidator`

This is the production sandbox pattern documented at [expression-runtime README](/home/ggrace/linux-coding/n8n/packages/@n8n/expression-runtime/README.md:93). `IsolatedVmBridge` provides a separate V8 isolate, configurable timeout, and hard memory limit; defaults are 5 seconds and 128 MB at [bridge.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/expression-runtime/src/types/bridge.ts:63).

For provisioning, use tighter limits than workflow expressions and a small dedicated pool. The facade should:

- expose only structured-cloned claims and provider metadata;
- expose no host functions, process, environment, filesystem, or network;
- enforce claim size/depth limits before copying into the isolate;
- require the final result to be boolean;
- always release the isolate in `finally`;
- never log raw claims;
- treat timeout, memory, syntax, and security failures as a policy-evaluation failure.

Do not use the legacy/unisolated evaluator, `new Function`, Node `vm`, or host-side Tournament evaluation.

Security implication: operators author the expression, but IdP claims remain untrusted input. The main risks are prototype-chain escape, CPU/memory exhaustion, hostile getters/proxies, accidental access to secrets, and PII leakage through errors/audit data. Safest behavior is to fail the login closed when a configured rule cannot be evaluated, recording rule ID and classified error—but not claims or claim values.

## 9. Open or under-pinned areas

These require explicit decisions and tests before implementation:

- Whether project “first match wins” is global or evaluated per target project. The relation model and event shape favor per-project resolution, but no multi-rule/multi-project test pins it.
- The API-types comment says `block:access` may appear on mapping rules, while the frontend explicitly permits it only as the instance default and forbids it on rule rows. Current executable tests only pin default-condition denial.
- Exact OIDC `$claims` merge/precedence between ID token and UserInfo.
- Direct-claim formats, particularly project claims, invalid roles, duplicates, and unknown project IDs.
- Owner/admin protection during automatic role downgrade or assignment.
- Whether a malformed/nonboolean rule denies immediately or is treated as nonmatching. Security favors denial.
- Project-access removal boundaries, including personal projects and memberships not originally created by provisioning.
- `PATCH` changing rule type, role/type compatibility, omitted versus empty `projectIds`, duplicate project IDs, and concurrent order inserts.
- `PatchRoleMappingRuleDto.order` currently accepts negative integers, unlike create/move DTOs.
- Authentication, licensing, and exact scope behavior for configuration GET are not independently tested.
- Null semantics for provisioning fields other than `defaultInstanceRole`.
- Whether to distribute config reload only in multi-main mode or always publish harmlessly.
- Audit/event behavior on transaction rollback; events should be emitted after commit.
- Role deletion must block roles referenced by mapping rules; [role.service.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/services/role.service.test.ts:1489) pins `Cannot delete role: referenced by 1 role mapping rule`. Blocking a role used only as `defaultInstanceRole` is expected by the clean-room notes but lacks an executable pin.
- The event provider union includes `ldap`, but LDAP provisioning evaluation is not otherwise in this rebuild’s pinned consumer scope.
- The shared `expression_based` mode is absent from the environment loader.
- Legacy `.ee` imports and white-box `provisioningConfig` mutations must be migrated completely rather than preserved through aliases.

Verification: the worktree remained clean; `master`, `HEAD`, and `origin/master` were all at zero ahead/behind after fetch. The focused loader suite empirically confirmed the three stale settings-key assertions. The provisioning integration suites cannot currently execute end-to-end because their endpoint/service imports still point to the purged `.ee` module—this is part of the missing surface identified above, not a source to recover.