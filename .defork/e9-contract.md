# Clean-room log-streaming contract inventory

Result: the surviving code pins the public/internal API, persistence shape, factory inputs, service surface, option schemas, environment loader, and observable delivery behavior. It does **not** pin concrete destination class names/constructors, listener fan-out/acknowledgment policy, circuit-breaker behavior, or the meaning of `removeDestination(id, false)`.

No deleted history or upstream Enterprise source was inspected. The repository remained unchanged.

## 1. Module file map

### Literally referenced paths

All paths are beneath `packages/cli/src/modules/log-streaming.ee/`.

| Required path | Required exports | Surviving consumers |
|---|---|---|
| `create-message-event-bus-destination.ts` | `createMessageEventBusDestination` | [public handler](/home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/handlers/log-streaming/log-streaming.handler.ts:12) |
| `log-streaming-destination.service.ts` | `LogStreamingDestinationService` | Public handler plus three integration suites |
| `log-streaming.controller.ts` | registration side effect and controller class, if convention requires one | Dynamically imported as `log-streaming.controller.js` by [test-server.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/shared/utils/test-server.ts:221) |
| `database/entities/index.ts` | `EventDestinations` | [instance-settings loader](/home/ggrace/linux-coding/n8n/packages/cli/src/instance-settings-loader/loaders/log-streaming.instance-settings-loader.ts:15) |
| `database/repositories/event-destination.repository.ts` | `EventDestinationsRepository` | Loader and loader unit tests |

Eight surviving files contain literal `log-streaming.ee` imports:

- [log-streaming.handler.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/handlers/log-streaming/log-streaming.handler.ts:12)
- [log-streaming.instance-settings-loader.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/instance-settings-loader/loaders/log-streaming.instance-settings-loader.ts:15)
- [loader unit test](/home/ggrace/linux-coding/n8n/packages/cli/src/instance-settings-loader/__tests__/log-streaming.instance-settings-loader.test.ts:8)
- [internal controller integration test](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/log-streaming.controller.test.ts:1)
- [public API integration test](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/public-api/log-streaming.test.ts:1)
- [loader integration test](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/log-streaming/log-streaming.instance-settings-loader.test.ts:1)
- [syslog TLS integration test](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/eventbus/syslog-tls.test.ts:10)
- [test-server.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/shared/utils/test-server.ts:221)

### Structurally required, but not literally imported

`log-streaming.module.ts` is required by the module loader. It first tries:

```text
modules/log-streaming/log-streaming.module.js
```

then:

```text
modules/log-streaming.ee/log-streaming.module.js
```

See [ModuleRegistry](/home/ggrace/linux-coding/n8n/packages/@n8n/backend-common/src/modules/module-registry.ts:17). The module must:

- register `EventDestinations` during `entities()`, before datasource initialization;
- initialize the destination service and controller/routes;
- be license-gated behaviorally by `feat:logStreaming`;
- support the applicable main/worker/webhook instance types, although the precise `instanceTypes` declaration is not pinned.

Concrete destination class paths and export names are not referenced anywhere surviving.

## 2. Destination class contracts

The canonical option schemas and defaults survive in [message-event-bus.ts](/home/ggrace/linux-coding/n8n/packages/workflow/src/message-event-bus.ts:58).

### Shared options

All destinations support:

```ts
{
  __type?: '$$AbstractMessageEventBusDestination'
    | '$$MessageEventBusDestinationWebhook'
    | '$$MessageEventBusDestinationSentry'
    | '$$MessageEventBusDestinationSyslog';
  id?: string;                    // non-empty when present
  label?: string;                 // non-empty when present
  enabled?: boolean;
  subscribedEvents?: string[];
  credentials?: Record<string, {
    id: string | null;
    name: string;
    __aiGatewayManaged?: boolean;
  }>;
  anonymizeAuditMessages?: boolean;
  circuitBreaker?: {
    maxFailures?: positiveInteger;
    maxDuration?: positiveInteger;
    halfOpenRequests?: positiveInteger;
    failureWindow?: positiveInteger;
    maxConcurrentHalfOpenRequests?: positiveInteger;
  };
}
```

Shared defaults:

```ts
{
  __type: '$$AbstractMessageEventBusDestination',
  id: '',
  label: 'New Event Destination',
  enabled: true,
  subscribedEvents: ['n8n.audit', 'n8n.workflow'],
  credentials: {},
  anonymizeAuditMessages: false,
}
```

### Webhook

Discriminator:

```text
$$MessageEventBusDestinationWebhook
```

Required:

```ts
url: string; // valid URL
```

Optional fields:

```ts
responseCodeMustMatch?: boolean;
expectedStatusCode?: integer;
method?: string;
authentication?: 'predefinedCredentialType' | 'genericCredentialType' | 'none';
sendQuery?: boolean;
sendHeaders?: boolean;
genericAuthType?: string;
nodeCredentialType?: string;
specifyHeaders?: string;
specifyQuery?: string;
jsonQuery?: string;
jsonHeaders?: string;
headerParameters?: {
  parameters: Array<{ name: string; value: string | number | boolean | null }>;
};
queryParameters?: sameShape;
sendPayload?: boolean;
options?: {
  batch?: { batchSize?: positiveInteger; batchInterval?: positiveInteger };
  allowUnauthorizedCerts?: boolean;
  queryParameterArrays?: 'indices' | 'brackets' | 'repeat';
  redirect?: {
    redirect: { followRedirects?: boolean; maxRedirects?: positiveInteger };
  };
  response?: {
    response?: {
      fullResponse?: boolean;
      neverError?: boolean;
      responseFormat?: string;
      outputPropertyName?: string;
    };
  };
  proxy?: {
    proxy: { protocol: 'http' | 'https'; host: string; port: positiveInteger };
  };
  timeout?: positiveInteger;
  socket?: {
    keepAlive?: boolean;
    maxSockets?: positiveInteger;
    maxFreeSockets?: positiveInteger;
  };
};
```

Defaults are at [message-event-bus.ts](/home/ggrace/linux-coding/n8n/packages/workflow/src/message-event-bus.ts:273), notably `POST`, payload enabled, status `200`, no auth/query/headers, and empty options.

Behaviorally pinned:

- Uses the factory-provided `OutboundHttp`; custom method and headers must reach the receiver.
- Sends a serialized event containing at least `eventName` and `id`.
- Credential references must resolve to decrypted request authentication at send time. The E2E suite proves header-auth credential delivery.
- Stored/serialized credentials remain `{ credentialType: { id, name } }` references, not decrypted secret values.
- Public API responses must never expose `credentials`, `authentication`, `genericAuthType`, `nodeCredentialType`, `responseCodeMustMatch`, `expectedStatusCode`, or `sendPayload`.
- Environment-managed configuration can store literal headers, including sensitive header values. They remain part of the persisted destination JSON.

Not pinned:

- Exact HTTP request body/content type.
- Whether SSRF protection is enabled for destination URLs.
- Redirect/response/batching semantics.
- Retry policy and circuit-breaker transitions.

### Sentry

Discriminator:

```text
$$MessageEventBusDestinationSentry
```

Options:

```ts
{
  dsn: string;                  // required valid URL
  tracesSampleRate?: number;    // 0 through 1 inclusive
  sendPayload?: boolean;
}
```

Defaults are `label: "Sentry DSN"`, `dsn: "https://"`, and `sendPayload: true`.

No surviving acceptance test pins the Sentry SDK call, event level, payload mapping, flushing, or shutdown semantics. Creation, validation, persistence, public serialization, and deletion are pinned.

### Syslog

Discriminator:

```text
$$MessageEventBusDestinationSyslog
```

Options:

```ts
{
  host: string;                  // required, non-empty
  expectedStatusCode?: integer;
  port?: positiveInteger;
  protocol?: 'udp' | 'tcp' | 'tls';
  facility?: integer;            // 0..23
  app_name?: string;
  eol?: string;
  tlsCa?: string;
}
```

Defaults:

```ts
{
  label: 'Syslog Server',
  expectedStatusCode: 200,
  host: '127.0.0.1',
  port: 514,
  protocol: 'tcp',
  facility: 16,
  app_name: 'n8n',
  eol: '\n',
}
```

The surviving [`@n8n/syslog-client`](/home/ggrace/linux-coding/n8n/packages/@n8n/syslog-client/src/index.ts:11) provides the natural transport seam:

```ts
createClient(target?: string, options?: ClientOptions): SyslogClient
client.log(message, options?): Promise<void>
client.close(): this
```

Protocol mapping must be:

| Destination protocol | Client transport |
|---|---|
| `udp` | `Transport.Udp` |
| `tcp` | `Transport.Tcp` |
| `tls` | `Transport.Tls` |

`tlsCa` maps to client option `tlsCA`. The client enforces TLS 1.2 minimum.

TLS acceptance pins:

- A TLS destination created enabled must deliver a newline-delimited message within five seconds.
- The line must contain the source event’s exact `eventName` and `id`.
- Invalid CA configuration must not make `MessageEventBus.send()` reject or crash the application.
- Nothing may arrive at the server.
- The exact log call is:

```text
Transport error
```

See [syslog-tls.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/eventbus/syslog-tls.test.ts:67). The TLS fixtures are valid test material: `certificate.pem` matches `key.pem`; `incorrect-certificate.pem` has a different issuer/CN.

### Lifecycle shared by all destinations

Required behavior:

- `start/register`: enabled destinations receive normal matching events.
- `test`: attempts delivery even when the destination is disabled.
- `close/unregister`: removal/replacement must stop delivery and close transport resources.
- `serialize`: returns canonical internal options, including the discriminator and ID.
- Updating an existing ID must replace/upsert it rather than create a duplicate.
- Disabled destinations must not receive ordinary events.
- Delivery errors must be contained and logged, not escape through `MessageEventBus.send()`.

However, the exact concrete method names, return types, constructor argument order, and abstract base class are not syntactically pinned. `start()`, `test()`, and `close()` are behavioral requirements, not recoverable signatures.

## 3. Service and factory contracts

### Factory

The exact call shape is pinned by the public handler:

```ts
createMessageEventBusDestination(
  eventBus: MessageEventBus,
  outboundHttp: OutboundHttp,
  options: MessageEventBusDestinationOptions,
): Destination
```

See [handler creation](/home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/handlers/log-streaming/log-streaming.handler.ts:87).

It must:

- dispatch on the three concrete `__type` values;
- reject missing/unknown types through controller validation or factory failure;
- tolerate omitted optional fields by applying operational defaults;
- return an object accepted by `LogStreamingDestinationService.addDestination()`;
- expose `serialize()`;
- connect webhook/Sentry outbound traffic through the provided `OutboundHttp`;
- connect to the surviving `MessageEventBus` `"message"` EventEmitter seam.

### `LogStreamingDestinationService`

Pinned surface:

```ts
initialize(): Promise<void>;

findDestination(
  id?: string,
): Promise<MessageEventBusDestinationOptions[]>;

addDestination(
  destination: Destination,
): Promise<Destination>;

removeDestination(
  id: string,
  unknownBoolean?: boolean,
): Promise<unknown>;

testDestination(
  id: string,
): Promise<boolean>;
```

Behavior:

- `initialize()` loads persisted rows and activates/registers their destination objects.
- `findDestination()` returns all destinations; with an ID it returns zero or one in an array.
- `addDestination()` persists and activates a new destination.
- If the serialized destination already has the path ID, `addDestination()` performs a full replacement/upsert.
- Its result must support `serialize()`.
- `removeDestination(id)` permanently removes the row and active destination.
- `testDestination(id)` attempts a test delivery and returns a boolean; public API converts thrown errors to `false`.
- Test delivery bypasses `enabled`.
- Replacement/removal must unregister previous event listeners and close TCP/TLS/Sentry/HTTP resources as applicable.

`removeDestination(id, false)` is exercised only by TLS cleanup at [syslog-tls.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/eventbus/syslog-tls.test.ts:58). The boolean’s name and semantics are not pinned.

## 4. Controller routes

### Internal REST routes

Pinned by [log-streaming.controller.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/log-streaming.controller.test.ts:40), DTOs, and `eventbus.test.ts`:

| Method/path | Input | Success | Other pins |
|---|---|---|---|
| `GET /eventbus/destination` | Optional query `id: non-empty string` | `200`; list/body exactness under-pinned | No auth `401`; unlicensed `403`; allowed while env-managed |
| `POST /eventbus/destination` | `CreateDestinationDto` | `200`, `{ data: serializedDestination }` | No auth `401`; unlicensed `403`; invalid body `400`; env-managed `403` |
| `DELETE /eventbus/destination?id={id}` | Required non-empty ID | Normal success body/status not pinned | No auth `401`; unlicensed `403`; env-managed `403` |
| `GET /eventbus/testmessage?id={id}` | Required non-empty ID | `200` in env-managed mode | Exact response body and missing-ID behavior not covered |

Valid POST discriminators:

```text
$$MessageEventBusDestinationWebhook
$$MessageEventBusDestinationSentry
$$MessageEventBusDestinationSyslog
```

Invalid cases pinned to `400`:

- missing `__type`;
- unknown `__type`;
- webhook with empty/invalid URL;
- Sentry with empty/invalid DSN;
- syslog with unsupported protocol.

Internal exact error messages are not pinned.

The controller must be licensed under `feat:logStreaming`. The frontend route requires `logStreaming:manage`, but the deleted controller’s exact authorization decorator is not recoverable.

### Public API

Base paths come from [openapi.yml](/home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/openapi.yml:200).

| Method/path | Scope | Success shape |
|---|---|---|
| `GET /settings/log-streaming/event-types` | `eventBusDestination:list` | `200 { data: eventNamesAll }` |
| `GET /settings/log-streaming/destinations` | `eventBusDestination:list` | `200 { data: PublicDestination[] }` |
| `GET /settings/log-streaming/destinations/{id}` | `eventBusDestination:read` | `200 PublicDestination`; unknown ID `404` |
| `POST /settings/log-streaming/destinations` | `eventBusDestination:create` | `200 PublicDestination`; server generates ID |
| `PUT /settings/log-streaming/destinations/{id}` | `eventBusDestination:update` | `200 PublicDestination`; full replacement using path ID |
| `POST /settings/log-streaming/destinations/{id}/test` | `eventBusDestination:test` | `200 { success: boolean }`; unknown ID `404` |
| `DELETE /settings/log-streaming/destinations/{id}` | `eventBusDestination:delete` | `200 PublicDestination` representing the deleted object; unknown ID `404` |

Every route:

- requires an API key: absent/invalid authentication gives `401`;
- applies `isLicensed('feat:logStreaming')`;
- gives `403` for missing scope;
- gives `403` when unlicensed, with exact message:

```text
Your license does not allow for feat:logStreaming. To enable feat:logStreaming, please upgrade to a license that supports this feature.
```

Public request discriminator values are friendly:

```text
webhook
syslog
sentry
```

The mapper converts them to/from the internal `$$...` values; see [log-streaming.mapper.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/public-api/v1/handlers/log-streaming/log-streaming.mapper.ts:9).

A client-supplied create ID is rejected with `400`. Validation errors return the first Zod issue as a bad-request message.

When environment-managed, GET and test remain allowed. POST, PUT, and DELETE return `409` with:

```text
Log streaming destinations are managed via environment variables and cannot be modified through the API
```

Unknown ID message:

```text
Log streaming destination with id "${id}" could not be found
```

The public schema intentionally removes backend-only fields; see [public-destination.dto.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/dto/log-streaming/public-destination.dto.ts:10).

## 5. DB entity/repository contract

No `EventDestinations` entity or repository survives in `@n8n/db` or the CLI tree.

### Table schema

PostgreSQL migration [1671535397530](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/postgresdb/1671535397530-MessageEventBusDestinations.ts:3):

```sql
CREATE TABLE ${tablePrefix}event_destinations (
  "id" UUID PRIMARY KEY NOT NULL,
  "destination" JSONB NOT NULL,
  "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

A later migration changes both timestamps to:

```sql
TIMESTAMP(3) WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP(3)
```

See [MigrateToTimestampTz](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/postgresdb/1694091729095-MigrateToTimestampTz.ts:23).

SQLite migration [1671535397530](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/sqlite/1671535397530-MessageEventBusDestinations.ts:3):

```sql
CREATE TABLE "${tablePrefix}event_destinations" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "destination" text NOT NULL,
  "createdAt" datetime(3) NOT NULL DEFAULT STRFTIME(...),
  "updatedAt" datetime(3) NOT NULL DEFAULT STRFTIME(...)
);
```

Entity requirements:

```ts
class EventDestinations {
  id: string;
  destination: MessageEventBusDestinationOptions;
  createdAt: Date;
  updatedAt: Date;
}
```

The exact entity decorators/base class are not pinned. The JSON column should use the project’s cross-database JSON abstraction so PostgreSQL stores JSONB and SQLite stores serialized text.

The nested `destination.id` must equal the row primary key. The environment-loader tests explicitly pin this duplication.

### Repository

Required export:

```ts
EventDestinationsRepository
```

Directly observed operations:

- `find()`
- `count()`
- `delete({})`
- `manager.transaction(...)`

The loader performs, in one transaction:

1. delete every `EventDestinations` row;
2. insert the replacement rows.

No custom repository method name is pinned by surviving callers. The destination service needs persistence CRUD, but its exact repository calls are absent.

The module must expose the entity through `entities()` even when unlicensed, because module entities are collected before `ModuleRegistry.initModules()` applies license gates.

## 6. Event subscription and filtering

### What `eventbus.test.ts` actually pins

Despite its name, [eventbus.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/eventbus.test.ts:11) contains only internal endpoint authentication/licensing checks. It explicitly says the substantive destination tests were in a deleted Enterprise test file.

It pins no event-filter algorithm.

### Surviving behavioral pins

Additional fair-code E2E coverage pins:

- An exact subscription such as `n8n.workflow.failed` receives that event.
- Group subscription `n8n.workflow` receives `n8n.workflow.*` and excludes audit events.
- Group subscription `n8n.audit` receives `n8n.audit.*` and excludes workflow events.
- `subscribedEvents: ['*']` is used by the Playwright helper as “all events,” but no acceptance assertion directly pins wildcard implementation.
- Disabled destinations receive no normal delivery.
- The test endpoint bypasses disabled state.
- With `anonymizeAuditMessages: true`, string values behind underscore-prefixed payload keys become `"*"`. Ordinary keys such as `is_own` remain intact.

Filtering should therefore support exact names, namespace prefixes, and `*`. The precise boundary algorithm—e.g. whether `n8n.work` accidentally matches `n8n.workflow.*`—is not pinned. A segment-aware check is the safest contract interpretation.

### Event-bus seam

The surviving [MessageEventBus](/home/ggrace/linux-coding/n8n/packages/cli/src/eventbus/message-event-bus/message-event-bus.ts:170) does **not** have `addDestination()` or `removeDestination()`.

Its delivery seam is:

```ts
eventBus.on(
  'message',
  (
    message: EventMessageTypes,
    confirmCallback: (
      message: EventMessageTypes,
      source: EventMessageConfirmSource,
    ) => void,
  ) => void,
);
```

Send sequence:

1. persist the serialized message to the event log;
2. emit `metrics.eventBus.event`;
3. emit `"message"` with the confirmation callback;
4. if no `"message"` listener exists, immediately confirm using:

```ts
{ id: '0', name: 'eventBus' }
```

Unconfirmed messages are retried by re-emitting `"message"`.

This creates a required but under-pinned coordination problem: once the service installs a listener, filtered-out, disabled, or partially failed deliveries must still reach a deliberate confirmation decision. Surviving code does not define whether:

- one service listener fans out to all destinations;
- each destination registers independently;
- one successful delivery confirms globally;
- every applicable destination must succeed before confirmation.

A single service-owned listener with explicit fan-out/aggregation is the least ambiguous rebuild design.

`eventNamesAll` is the public event-type source and currently concatenates audit, workflow, node, worker/generic, AI, runner, queue, and MCP arrays. It omits `eventNamesExecution` and the test-only `n8n.destination.test`; see [event-message index](/home/ggrace/linux-coding/n8n/packages/cli/src/eventbus/event-message-classes/index.ts:172).

`LogStreamingEventRelay` requires nothing from the deleted module. It is solely a producer from `EventService` into `MessageEventBus`; see [relay constructor](/home/ggrace/linux-coding/n8n/packages/cli/src/events/relays/log-streaming.event-relay.ts:32). Server startup initializes the bus, then the relay, at [server.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/server.ts:259).

## 7. Instance-settings-loader contract

Configuration:

```text
N8N_LOG_STREAMING_MANAGED_BY_ENV
N8N_LOG_STREAMING_DESTINATIONS
```

Defaults are `false` and an empty string respectively.

Accepted JSON is a strict array discriminated by:

```ts
type: 'webhook' | 'syslog' | 'sentry'
```

Each variant derives from the corresponding canonical schema, replaces `__type` with `type`, and allows:

```ts
id?: UUID;
```

Unknown fields fail. Empty string and `[]` are both valid empty configurations.

### `run()` behavior

When management is disabled:

- no DB calls;
- returns `"skipped"`;
- exact debug message:

```text
logStreamingManagedByEnv is disabled — skipping log streaming destinations env config
```

When enabled:

- exact informational message:

```text
logStreamingManagedByEnv is enabled — replacing log streaming destinations from env vars
```

- parse and validate the complete input before mutating the DB;
- replace all destination rows transactionally;
- preserve explicit UUIDs;
- generate UUIDs for omitted IDs;
- place the same ID in the row and nested destination;
- convert friendly `type` to internal `__type`;
- return `"created"` even for an empty replacement.

Error templates:

```text
N8N_LOG_STREAMING_DESTINATIONS is not valid JSON: ${jsonError}
```

```text
N8N_LOG_STREAMING_DESTINATIONS validation failed at "${path}": ${firstIssueMessage}
```

```text
N8N_LOG_STREAMING_DESTINATIONS has duplicate id "${id}" at index ${index}
```

On failure:

- log the message with `logger.error(message)`;
- throw `InstanceBootstrappingError(message)`;
- leave the DB unchanged.

Only explicit IDs participate in duplicate detection. Generated IDs do not.

Pinned validation examples include rejection of:

- a non-array root;
- unknown type;
- missing webhook URL;
- non-UUID explicit ID;
- duplicate ID;
- unknown property;
- syslog facility outside `0..23`.

TLS without a CA and all five circuit-breaker fields are accepted.

The orchestrating service invokes it under the name `"log-streaming"`; see [instance-settings-loader.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/instance-settings-loader/instance-settings-loader.service.ts:31).

## 8. Open questions and under-pinned areas

1. **Concrete class API:** destination class names, files, constructors, inheritance, and exact lifecycle method signatures are absent.

2. **Acknowledgment aggregation:** the event bus confirmation model is global per message, while multiple-destination success requirements are unspecified.

3. **`removeDestination(id, false)`:** the second parameter’s meaning is unknown.

4. **Shutdown ownership:** no surviving consumer explicitly invokes a destination-service shutdown method. Resource closure during process shutdown needs a new explicit decision.

5. **Circuit breaker:** schemas survive, but no behavior, state machine, timing units, persistence, or error classification is tested.

6. **Webhook details:** exact payload encoding, response-code handling, credentials resolver, SSRF policy, proxy handling, batching, and retry semantics are not pinned.

7. **Sentry details:** SDK construction, event mapping, client isolation, flush/close behavior, and whether `tracesSampleRate` applies to this use case are not pinned.

8. **Syslog formatting:** the tests require a TLS-delivered line containing ID/event name, but do not pin RFC 3164 versus RFC 5424 or the complete message layout.

9. **Filtering boundary:** exact and namespace-prefix behavior is established; segment-boundary and wildcard details are incomplete.

10. **Internal controller responses:** POST shape is pinned, but GET, DELETE, and test body shapes are not fully asserted. Exact internal error messages are absent.

11. **Module metadata:** the required license behavior is clear, but exact `@Module(...)` metadata and supported `instanceTypes` are not recoverable.

12. **Factory validation/default normalization:** canonical defaults survive, but whether `serialize()` includes every filled default or preserves omitted fields is untested.

13. **Writer retry compatibility:** the surviving writer reconstructs only generic, workflow, audit, node, and MCP messages from disk. Execution, AI, runner, and queue event retry behavior is presently incomplete and should be treated as a rebuild risk.

Verification: all named evidence files were readable, the purged directory is absent, the eight literal import consumers were reconciled, `git diff --exit-code` passed, and the worktree remained clean. Acceptance suites were not run because the module they import is intentionally absent.