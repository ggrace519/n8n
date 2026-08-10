# Clean-room rebuild contract

The two purged files are absent from both the working tree and current history-facing references. This contract is derived exclusively from surviving fair-code, tests, DTOs, decorators, configuration, and public changelog metadata. No Enterprise implementation was accessed or reconstructed.

Evidence labels used below:

- **Pinned** — directly asserted by a surviving test or exact consumer signature.
- **Required** — necessary to satisfy the surviving architecture and state invariants.
- **Under-pinned** — behavior must be chosen and tested during the rebuild.

## 1. File map and required exports

| File | Required export | Required public surface |
|---|---|---|
| `packages/cli/src/scaling/multi-main-setup.ee.ts` | `@Service() export class MultiMainSetup` | `init(): Promise<void>`, `shutdown(): Promise<void>`, `registerEventHandlers(): void`, `fetchLeaderKey(): Promise<string \| null>`, EventEmitter-compatible `on()`/`emit()` |
| `packages/cli/src/scaling/worker-status.service.ee.ts` | `@Service() export class WorkerStatusService` | `requestWorkerStatus(requestingUserId: string): Promise<void>`, `handleWorkerStatusResponse(status): void`; a worker-side request handler is also required |

No other exports from either module are referenced.

### Surviving supporting files

| File | Rebuild role |
|---|---|
| [leader-election-client.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/leader-election-client.ts:58) | Complete Redis primitive layer for leader reads, NX acquisition, owner-checked TTL renewal, deletion, and disconnect |
| [scaling.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/scaling.service.ts:581) | Queue/job orchestration; reacts to leadership but does not elect leaders |
| [scaling.types.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/scaling.types.ts) | Scaling/job types; no leader state machine |
| [constants.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/constants.ts) | Pubsub channel names and command behavior sets |
| [redis-lock.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/redis-lock.service.ts) | Generic token-based lock service; not a substitute for leader election |
| [publisher.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/pubsub/publisher.service.ts:69) | Publishes worker-status requests and responses |
| [subscriber.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/pubsub/subscriber.service.ts:141) | Receives, filters, debounces, and dispatches pubsub events |
| [pubsub.event-map.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/pubsub/pubsub.event-map.ts:62) | Exact worker-status event names and payloads |
| [pubsub.registry.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/pubsub/pubsub.registry.ts) | Registers `@OnPubSubEvent` handlers and applies instance/leader filters |
| [job-processor.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/job-processor.ts) | Supplies `getRunningJobsSummary()` |
| [worker-server.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/scaling/worker-server.ts) | Independent HTTP health/readiness/metrics surface; not a source for the worker-status DTO |
| [instance-settings.ts](/home/ggrace/linux-coding/n8n/packages/core/src/instance-settings/instance-settings.ts:166) | Authoritative local leadership state |

The old Publisher key/value helpers are explicitly described as supporting “legacy leader election”. The rebuild should use `LeaderElectionClient`, not those Publisher methods.

---

## 2. `MultiMainSetup` full contract

### Constructor dependencies

No surviving test pins the exact constructor order. The minimum clean-room dependency set is:

```ts
constructor(
  logger: Logger,
  globalConfig: GlobalConfig,
  instanceSettings: InstanceSettings,
  leaderElectionClient: LeaderElectionClient,
  multiMainMetadata: MultiMainMetadata,
)
```

`MultiMainMetadata` could technically be resolved through `Container`, as the decorator test does, but injecting it gives the cleaner boundary.

There is no surviving need for `Publisher`, `Subscriber`, `ScalingService`, or `RedisLockService` in this class.

### Boundary with `LeaderElectionClient`

`LeaderElectionClient` already provides:

```ts
getLeader(): Promise<Result<string | null, Error>>
setLeaderIfNotExists(): Promise<Result<boolean, Error>>
tryRenewLeaderTtl(): Promise<Result<TtlRenewalResult, Error>>
clearLeader(): Promise<Result<void, Error>>
destroy(): void
```

Its key is:

```text
<validated Redis prefix>:main_instance_leader
```

The stored value is `InstanceSettings.hostId`.

Acquisition is atomic:

```text
SET key hostId EX <ttl-seconds> NX
```

Renewal is also atomic and owner-checked. Its result variants are exactly:

```ts
{ id: 'success' }
{ id: 'key-missing' }
{ id: 'other-host-is-leader', currentLeaderId: string }
```

Unexpected Lua results become:

```text
Unexpected result from Redis script: <JSON result>
```

Every Redis operation has a 5-second command timeout and returns a `Result`; it does not throw Redis errors itself.

What `LeaderElectionClient` does **not** provide:

- election scheduling;
- initial role assignment;
- local/remote reconciliation;
- state transitions;
- takeover/stepdown events;
- logging/retries;
- shutdown policy.

Those are all `MultiMainSetup` responsibilities.

### `InstanceSettings` mutation

`InstanceSettings` starts every main as:

```ts
instanceRole = 'unset'
```

Its exact setters are:

```ts
instanceSettings.markAsLeader();
instanceSettings.markAsFollower();
```

Its predicates are:

```ts
instanceSettings.isLeader
instanceSettings.isFollower
```

`hostId` is restart-scoped:

```text
<instanceType>-<Docker hostname>
```

or, outside Docker:

```text
<instanceType>-<nanoid>
```

Single-main startup calls `markAsLeader()` directly. No surviving multi-main code besides the missing module can assign the initial leader/follower role. Therefore `MultiMainSetup.init()` must assign a definitive role before it resolves.

The local state must be changed **before** emitting a lifecycle event. Several pubsub registrations and handlers inspect `instanceSettings.isLeader` dynamically.

### `init()` lifecycle

Required ordering:

1. Create/use the already-injected `LeaderElectionClient`.
2. Perform an immediate leader check; do not wait for the first interval.
3. Reconcile the Redis value with `instanceSettings.hostId`.
4. Set `instanceRole` to `leader` or `follower`.
5. Start periodic checks every configured interval.
6. Return only after the initial role is known.

This ordering is required because [start.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/commands/start.ts:333) awaits `init()` before initializing the license and other role-dependent services.

A suitable state matrix is:

| Local state | Redis result | Required result |
|---|---|---|
| `unset`/follower | current leader equals local `hostId` | Mark leader; this is local/remote state reconciliation |
| `unset`/follower | another `hostId` | Mark follower |
| `unset`/follower | key absent | Attempt `setLeaderIfNotExists()`; leader only when it returns `true` |
| leader | renewal `success` | Remain leader |
| leader | `other-host-is-leader` | Mark follower, then emit stepdown |
| leader | `key-missing` | Attempt atomic reacquisition; remain leader only if NX succeeds, otherwise step down |
| any | Redis operation error | See failure semantics below |

A failed NX claim must not be treated as proof that the local process is leader. Another process won the race.

Public changelog metadata independently confirms the intended themes:

- initialization before checking leader/follower;
- checking against the leader key ID;
- reconciling remote and local election state;
- emitting `leader-takeover` on a leadership mismatch found during `checkLeader`.

The name `checkLeader` is therefore strongly suggested, but no surviving consumer requires it to be public.

### TTL and renewal

Configuration defaults are:

```text
TTL:       10 seconds
interval:   3 seconds
```

A leader must renew through `tryRenewLeaderTtl()`. It must not implement renewal as separate `GET` and `EXPIRE` calls.

The interval loop should not permit overlapping checks. This is not test-pinned, but is required to avoid an older check completing after a newer transition.

Neither the config class nor the tests validate `interval < ttl`. The rebuilt service should validate that invariant or fail startup with an actionable configuration error.

### Leadership events

Exact event names:

```text
leader-takeover
leader-stepdown
```

Exact payload: **none**.

Decorator handlers have the shape:

```ts
() => void | Promise<void>
```

Required transition ordering:

```ts
instanceSettings.markAsLeader();
emit('leader-takeover');
```

and:

```ts
instanceSettings.markAsFollower();
emit('leader-stepdown');
```

Unchanged state must not emit duplicate events.

### `registerEventHandlers()`

`MultiMainMetadata` stores registrations from:

```ts
@OnLeaderTakeover()
@OnLeaderStepdown()
```

The surviving decorator test pins the functional behavior to:

```ts
metadata.subscribe(({ eventHandlerClass, methodName, eventName }) => {
  this.on(eventName, async () => {
    const instance = Container.get(eventHandlerClass);
    return await instance[methodName].call(instance);
  });
});
```

Required properties:

- handlers registered before subscription are replayed;
- handlers registered after subscription are delivered dynamically;
- multiple handlers for the same event all run;
- multiple classes are supported;
- instance methods are invoked with the resolved instance as `this`;
- no arguments are passed;
- asynchronous handlers are invoked;
- only one metadata subscriber is allowed.

A second metadata subscription throws exactly:

```text
A listener is already subscribed to handler registrations
```

`Start` deliberately separates election from handler wiring:

```ts
await Container.get(MultiMainSetup).init();
```

happens early, while:

```ts
Container.get(MultiMainSetup).registerEventHandlers();
```

runs after module initialization.

Whether the initial `unset → leader` assignment emits a takeover event is not pinned. Existing services initialize themselves according to `isLeader`, so startup does not depend on receiving that initial event.

### All surviving leadership consumers

| Component | Takeover handler | Stepdown handler/effect |
|---|---|---|
| `ActiveWorkflowManager` | `addAllNonWebhookTriggerWorkflows()` | `removeAllNonWebhookTriggerWorkflows()`; also shutdown |
| `License` | `enableAutoRenewals()` | `disableAutoRenewals()` |
| `PrometheusInstanceRoleMetrics` | `updateOnLeaderTakeover()` sets gauge `1` | `updateOnLeaderStepdown()` sets gauge `0` |
| `AgentTaskService` | `reconnectAll()` | `stopAll()`; also shutdown |
| `ChatIntegrationService` | `reconnectAll()` | `disconnectLeaderOnlyIntegrations()` |
| `N8NCheckpointStorage` | `startPruning()` | `stopPruning()` |
| `DiscordIntegration` | `startAllGateways()` | `stopAllGateways()`; also shutdown |
| `InsightsService` | `startCompactionAndPruningTimers()` | `stopCompactionAndPruningTimers()` |
| `InstanceAiService` | `startCheckpointPruning()` | `stopCheckpointPruning()` |
| instance-registry `CheckService` | `startReconciliation()` | `stopReconciliation()` |
| `StaleMemberCleanupService` | `startCleanup()` | `stopCleanup()` |
| `McpRegistryService` | `onLeaderTakeover()` | `onLeaderStepdown()` |
| `JtiCleanupService` | `startCleanup()` | `stopCleanup()` |
| `TrustedKeyService` | `onLeaderTakeover()` | `stopRefresh()` |
| `ScalingService` | `scheduleQueueRecovery()` | `stopQueueRecovery()` |
| `ExecutionsPruningService` | `startPruning()` | `stopPruning()` |
| `WorkflowHistoryCompactionService` | `startCompacting()` | `stopCompacting()` |
| `WorkflowStatisticsRollupService` | `start()` | `stop()` |
| `WaitTracker` | `startTracking()` | `stopTracking()` |
| `PublishedWorkflowTriggerDeactivator` | — | `deactivateAllNonWebhookTriggers()`; also shutdown |
| `WorkflowPublicationOutboxCleanupService` | `startCleanup()` | `stopCleanup()` |
| `WorkflowPublicationOutboxConsumer` | `wakeUp()` | — |
| `WorkflowPublicationReconciler` | `reconcileOnLeaderTakeover()` | — |

This makes stepdown time-sensitive: triggers, maintenance timers, queue recovery, renewals, gateways, and leader-only integrations must stop promptly after leadership is lost.

### `fetchLeaderKey()`

Pinned success contract:

```ts
fetchLeaderKey(): Promise<string | null>
```

It returns the current Redis leader value, i.e. a `hostId`, or `null` when no leader key exists.

The debug controller uses it as:

```ts
const leaderKey = await this.multiMainSetup.fetchLeaderKey();
```

and returns it unchanged. The integration test pins a successful string value of:

```text
some-leader-key
```

Whether a Redis error is thrown, logged and converted to `null`, or represented another way is not pinned. Throwing is preferable to making “Redis unavailable” indistinguishable from “no leader”.

---

## 3. `WorkerStatusService` contract

### Constructor

The surviving unit test pins constructor order:

```ts
constructor(
  jobProcessor: JobProcessor,
  instanceSettings: InstanceSettings,
  publisher: Publisher,
  push: Push,
)
```

### Main-side request

Pinned controller call:

```ts
await workerStatusService.requestWorkerStatus(req.user.id);
```

Required publication:

```ts
await publisher.publishCommand({
  command: 'get-worker-status',
  payload: { requestingUserId },
});
```

The method returns no data. Worker responses arrive asynchronously through pubsub/push.

### Worker-side request handler

The clean-room implementation requires:

```ts
@OnPubSubEvent('get-worker-status', { instanceType: 'worker' })
async handleWorkerStatusRequest({
  requestingUserId,
}: {
  requestingUserId: string;
}): Promise<void>
```

The exact method name is not pinned; event and filter are.

It must collect one status snapshot and publish:

```ts
await publisher.publishWorkerResponse({
  senderId: instanceSettings.hostId,
  response: 'response-to-get-worker-status',
  payload: {
    ...workerStatus,
    requestingUserId,
  },
});
```

Both the envelope and status payload identify the worker.

### Main-side response handler

Required decorator:

```ts
@OnPubSubEvent('response-to-get-worker-status', { instanceType: 'main' })
```

The unit test pins synchronous push behavior:

```ts
handleWorkerStatusResponse(
  status: WorkerStatus & { requestingUserId: string },
): void {
  push.sendToUsers(
    {
      type: 'sendWorkerStatusMessage',
      data: {
        workerId: status.senderId,
        status,
      },
    },
    [status.requestingUserId],
  );
}
```

The full incoming object, including `requestingUserId`, remains inside `data.status`. That is an observable, test-pinned leak beyond the public `WorkerStatus` type.

### Exact status payload

From [scaling.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/scaling.ts:13):

```ts
type WorkerStatus = {
  senderId: string;
  runningJobsSummary: Array<{
    executionId: string;
    workflowId: string;
    workflowName: string;
    mode: WorkflowExecuteMode;
    startedAt: Date;
    retryOf?: string;
    status: ExecutionStatus;
  }>;
  isInContainer: boolean;
  process: {
    memory: {
      available: number;
      constraint: number;
      rss: number;
      heapTotal: number;
      heapUsed: number;
    };
    uptime: number;
  };
  host: {
    memory: {
      total: number;
      free: number;
    };
  };
  freeMem: number;
  totalMem: number;
  uptime: number;
  loadAvg: number[];
  cpus: string;
  arch: string;
  platform: NodeJS.Platform;
  hostname: string;
  interfaces: Array<{
    family: 'IPv4' | 'IPv6';
    address: string;
    internal: boolean;
  }>;
  version: string;
};
```

Proven data sources:

- `senderId`: `instanceSettings.hostId`
- `runningJobsSummary`: `jobProcessor.getRunningJobsSummary()`
- `isInContainer`: `instanceSettings.isDocker`
- RSS/heap figures: Node process memory usage
- process uptime: Node process uptime
- host totals/free/load/architecture/platform/hostname/interfaces: Node `os`
- version: n8n version constant

`JobProcessor.getRunningJobsSummary()` returns stored running-job metadata without the internal `run` handle.

The exact CPU string construction, interface flattening order, handling of missing constrained/available memory, and snapshot timing are under-pinned.

`WorkerServer` does not provide this data. Its independent surface is:

- health: `{ status: 'ok' }`;
- readiness: `200` only after DB, migrations, Redis, and worker setup are ready; otherwise `503 { status: 'error' }`;
- Prometheus metrics.

---

## 4. Exact pubsub contract

### Channels

Logical names:

```text
n8n.commands
n8n.worker-response
```

Actual channel names are:

```text
<globalConfig.redis.prefix>:n8n.commands
<globalConfig.redis.prefix>:n8n.worker-response
```

With the default prefix, tests observe:

```text
n8n:n8n.commands
n8n:n8n.worker-response
```

### Main → workers

Event-map entry:

```ts
'get-worker-status': {
  requestingUserId: string;
}
```

Service input:

```ts
{
  command: 'get-worker-status',
  payload: {
    requestingUserId: string
  }
}
```

Publisher wire envelope:

```ts
{
  command: 'get-worker-status',
  payload: { requestingUserId },
  senderId: <main hostId>,
  selfSend: false,
  debounce: true
}
```

`get-worker-status` belongs to neither the self-send nor immediate-command set. Consequently it is debounced by the subscriber, currently with the common pubsub debounce behavior. Bursts can collapse into the latest request; there is no request ID.

### Worker → mains

Event-map entry:

```ts
'response-to-get-worker-status':
  WorkerStatus & { requestingUserId: string }
```

Wire envelope:

```ts
{
  senderId: <worker hostId>,
  response: 'response-to-get-worker-status',
  payload: {
    ...WorkerStatus,
    requestingUserId: string
  }
}
```

Worker responses are not decorated with `selfSend` or an automatic debounce flag.

Every main subscribes to the worker-response channel. Responses are not target-filtered by `Subscriber`, so each main receives them and attempts to push only to the specified local user connection. This provides multi-main websocket fanout without choosing a particular main.

### Push event

Exact API push event:

```ts
{
  type: 'sendWorkerStatusMessage',
  data: {
    workerId: string,
    status: WorkerStatus
  }
}
```

There is also a surviving command-map entry:

```ts
'get-worker-id': never
```

No corresponding response-map entry or surviving handler exists. It is orphaned and is not part of the required worker-status rebuild.

---

## 5. Consumer integration points

### `Start`

Relevant exact calls from [start.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/commands/start.ts:309):

```ts
Container.get(Publisher);
Container.get(PubSubRegistry).init();

const subscriber = Container.get(Subscriber);
await subscriber.subscribe(subscriber.getCommandChannel());
await subscriber.subscribe(subscriber.getWorkerResponseChannel());
await subscriber.subscribe(subscriber.getMcpRelayChannel());

if (instanceSettings.isMultiMain) {
  await Container.get(MultiMainSetup).init();
} else {
  instanceSettings.markAsLeader();
}
```

After modules load:

```ts
if (instanceSettings.isMultiMain) {
  Container.get(MultiMainSetup).registerEventHandlers();
}
```

Shutdown:

```ts
if (instanceSettings.isMultiMain) {
  await Container.get(MultiMainSetup).shutdown();
}
```

That occurs before:

```ts
Container.get(Publisher).shutdown();
Container.get(Subscriber).shutdown();
```

### `Worker`

From [worker.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/commands/worker.ts:156):

```ts
Container.get(Publisher);
Container.get(PubSubRegistry).init();

const subscriber = Container.get(Subscriber);
await subscriber.subscribe(subscriber.getCommandChannel());

Container.get(WorkerStatusService);
Container.get(ExecutionStopService);
```

The worker test explicitly asserts that `WorkerStatusService` is instantiated during orchestration setup.

### Orchestration controller

From [orchestration.controller.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/controllers/orchestration.controller.ts:7):

```text
POST /orchestration/worker/status
Global scope: orchestration:read
```

Behavior:

```ts
if (!licenseService.isWorkerViewLicensed()) return;

return await workerStatusService.requestWorkerStatus(req.user.id);
```

The route returns no worker array; statuses arrive through push messages.

### Debug controller

From [debug.controller.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/controllers/debug.controller.ts:17):

```text
GET /debug/multi-main-setup
skipAuth: true
```

It returns:

```ts
{
  instanceId,
  leaderKey,
  isLeader,
  activeWorkflows: {
    webhooks,
    triggersAndPollers,
  },
  activationErrors,
}
```

### `WaitTracker`

Current production behavior:

```ts
init() {
  if (instanceSettings.isLeader) startTracking();
}
```

Lifecycle hooks:

```ts
@OnLeaderTakeover()
private startTracking()

@OnLeaderStepdown()
stopTracking()
```

`startTracking()` performs an immediate database query and polls every 60 seconds. Pinned log text:

```text
Started tracking waiting executions
```

`stopTracking()` clears the poll timer and every tracked execution timeout. Pinned log text:

```text
Stopped tracking waiting executions
```

The 755-line test retains a type-only `MultiMainSetup` import and an `.on()` mock, but neither is passed to nor used by the current `WaitTracker`. This is stale scaffolding, not a constructor or callback contract.

### `BaseCommand`

For command startup:

```ts
const isMultiMainEnabled =
  globalConfig.executions.mode === 'queue' &&
  globalConfig.multiMainSetup.enabled;

instanceSettings.setMultiMainEnabled(isMultiMainEnabled);
instanceSettings.setMultiMainLicensed(isMultiMainEnabled);
```

The second assignment deliberately skips a license check because the `start` command performs the real one.

`RedisLockService` is initialized when queue mode, multi-main, or Redis-backed cache requires it, but that generic service is separate from `MultiMainSetup`.

---

## 6. Configuration, environment, and licensing

From [multi-main-setup.config.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/config/src/configs/multi-main-setup.config.ts:3):

| Field | Environment variable | Default | Unit |
|---|---|---:|---|
| `enabled` | `N8N_MULTI_MAIN_SETUP_ENABLED` | `false` | boolean |
| `ttl` | `N8N_MULTI_MAIN_SETUP_KEY_TTL` | `10` | seconds |
| `interval` | `N8N_MULTI_MAIN_SETUP_CHECK_INTERVAL` | `3` | seconds |

Multi-main is effectively enabled only when:

```ts
executions.mode === 'queue' && multiMainSetup.enabled
```

License feature constants:

```text
feat:multipleMainInstances
feat:workerView
```

`Start` temporarily marks multi-main as licensed so leader election can set the role before license initialization. Afterward it performs the real entitlement check.

A follower that does not initially observe the multi-main license retries after:

```text
2s, 4s, 8s, 16s, 32s
```

Pinned warning template:

```text
Instance not licensed for multi-main — retrying license check in ${delayMs / 1000}s (attempt ${attempt}/${maxRetries})
```

A leader fails immediately when the entitlement is absent; after follower retries are exhausted, startup throws `FeatureNotLicensedError` for `feat:multipleMainInstances`.

Instance roles are exactly:

```text
unset
leader
follower
```

Non-main instance types remain `unset`.

---

## 7. Failure and shutdown semantics

### Redis operation failure

Pinned primitive behavior:

- leader-election commands time out after 5 seconds;
- `LeaderElectionClient` returns `{ ok: false, error }`;
- it does not mutate local leadership or log/retry;
- Redis clients retry connections and eventually terminate the process after the configured Redis timeout threshold outside tests.

Required multi-main behavior:

- an initial election error must fail startup or otherwise prevent role-dependent initialization; returning with `instanceRole === 'unset'` violates downstream assumptions;
- a periodic renewal error must fail closed: the local process cannot safely continue leader-only work after it can no longer prove ownership;
- on demotion, mark follower before emitting `leader-stepdown`;
- recovery may later reacquire through NX and emit takeover.

The exact retry/logging policy is not pinned.

### Lost leadership mid-flight

Loss is positively detected when renewal returns:

```ts
{ id: 'other-host-is-leader', currentLeaderId }
```

or when a missing key cannot be reacquired.

Required sequence:

1. stop treating the process as leader;
2. emit `leader-stepdown`;
3. invoke all registered stepdown handlers;
4. allow a later check to attempt NX acquisition;
5. emit `leader-takeover` only after acquisition succeeds and local state is leader.

Raw Node `EventEmitter.emit()` does not await asynchronous listeners. The decorator tests only pin eventual invocation, not transition completion or error aggregation. Because several teardown handlers are async, the rebuild should explicitly define whether transitions await them. Awaiting all handlers with error reporting is the safer clean-room design.

### Shutdown ordering

Overall `Start.stopProcess()` order is:

1. cancel queued workflow activations;
2. `WaitTracker.stopTracking()`;
3. run `n8n.stop` external hooks;
4. remove non-webhook trigger workflows;
5. `await MultiMainSetup.shutdown()`;
6. disconnect Publisher;
7. disconnect Subscriber;
8. emit `instance-stopped`;
9. shut down active executions;
10. close the message event bus.

Inside `MultiMainSetup.shutdown()`, the required order is:

1. mark shutdown state and stop the election timer;
2. wait for or invalidate any in-flight check;
3. release leadership only if ownership can be proven;
4. disconnect `LeaderElectionClient` last.

`LeaderElectionClient.clearLeader()` currently performs an unconditional `DEL`. That is unsafe if the local role is stale: a former leader could delete a newer leader’s key. A correct rebuild needs either:

- a new atomic compare-and-delete operation in `LeaderElectionClient`; or
- no explicit deletion, relying on TTL expiry.

A preceding `GET` followed by `clearLeader()` is still a TOCTOU race and is not sufficient.

Whether shutdown emits `leader-stepdown` is not pinned. Many consumers also have `@OnShutdown`, so emitting it during shutdown can duplicate cleanup. The rebuild should choose and test one coherent policy.

### Worker-status failures

- Failure to publish the request rejects `requestWorkerStatus()` and propagates through the controller.
- Failure to publish a worker response rejects the worker-side pubsub handler unless explicitly caught.
- There is no aggregate response, timeout, completion signal, correlation ID, or missing-worker report.
- Every responding worker generates an independent push event.
- Malformed pubsub messages are dropped with:

```text
Received malformed pubsub message
```

- Subscription failure logs:

```text
Failed to subscribe to channel ${channel}
```

---

## 8. Explicitly open or under-pinned areas

These cannot be recovered from surviving fair-code and need clean-room decisions plus new tests:

1. Exact `MultiMainSetup` constructor order and whether metadata/logger are injected or container-resolved.
2. Exact private method names besides the publicly evidenced `init`, `shutdown`, `registerEventHandlers`, and `fetchLeaderKey`.
3. Whether initial role assignment emits `leader-takeover`.
4. Exact transition logging strings and log levels.
5. Redis error retry/backoff policy during election.
6. How quickly a process demotes after a renewal error.
7. Whether lifecycle transitions await asynchronous decorator handlers, handler ordering, and error aggregation.
8. Atomic owner-safe leader deletion; the surviving `clearLeader()` primitive is insufficient.
9. `fetchLeaderKey()` error semantics.
10. Enforcement of `interval < ttl`, minimum TTL, and renewal safety margin.
11. Interval implementation, overlap prevention, and timer `unref()` behavior.
12. Exact worker CPU string formatting.
13. Network-interface flattening/filtering and deterministic order.
14. Handling of unavailable process memory constraint/available-memory APIs.
15. Whether `requestingUserId` should continue leaking inside public `status`; tests currently require it.
16. Debouncing concurrent `get-worker-status` requests by event name can collapse requests from different users.
17. No correlation ID, response deadline, worker enumeration, or “all responses received” signal exists.
18. The orphaned `get-worker-id` command has no surviving response contract.
19. The unauthenticated debug route is current consumer behavior, but not part of either service’s internal contract.
20. Some leader-only consumers initialize from `isLeader`, while others depend on takeover events; the rebuild needs transition tests covering both initial boot and later failover.

Static verification confirmed both target modules remain absent and that all current imports, leadership decorators, worker-status DTOs, pubsub entries, and lifecycle consumers listed above are present on the clean `feat/defork-e10-multi-main` checkout.