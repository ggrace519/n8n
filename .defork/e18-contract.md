# Clean-room workflow-reviews backend contract

All conclusions below come only from surviving fair-code in the current working tree at `cd250fc9c0cd`. No purged files, history, upstream Enterprise sources, or recovery paths were consulted.

Contract-strength labels:

- **Pinned** — exact path, symbol, schema, route, shape, or behavior is directly asserted by surviving code/tests.
- **Required-integration** — necessary to satisfy pinned consumers, although internal implementation details are not fixed.
- **Under-pinned** — surviving sources do not determine one correct behavior.

## 1. Module file map and required exports

| File/symbol | Strength | Contract |
|---|---|---|
| `packages/cli/src/modules/workflow-reviews/workflow-reviews.module.ts` | **Pinned** | The module registry loads this exact clean path for module name `workflow-reviews`. It must register entities before datasource initialization and register routes/providers during module initialization. See [module-registry.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/backend-common/src/modules/module-registry.ts:43). |
| `WorkflowReviewsModule` class name | **Under-pinned** | A `@BackendModule({ name: 'workflow-reviews', ... })` class is required, but its exported class name is not consumed directly. |
| `packages/@n8n/db/src/entities/workflow-review-request.ts` exporting `WorkflowReviewRequest` | **Required-integration**, class name **Pinned** | The ownership manifest discovers the literal class name and pins it to its declaring file. This clean path is the natural replacement; the manifest must point to it. |
| `WorkflowReviewRequestWorkflow` entity | **Pinned** | The workflow-history integration test truncates this exact entity name. Its physical file placement is under-pinned. |
| Reviewer/author junction mappings | Tables **Pinned**, class structure **Under-pinned** | They may be explicit entities or ORM join-table relations, provided they reproduce the migration schema exactly. |
| `WorkflowReviewRequestRepository` | **Pinned** | Must be exported from `@n8n/db`. The surviving integration test imports it directly. |
| `WorkflowReviewRequestWorkflowRepository` | **Pinned** | Must be exported from `@n8n/db`. |
| `createRequest(input, ctx)` | **Pinned** | Required on `WorkflowReviewRequestRepository`; returns the created request. |
| `createWorkflowRow(input, ctx)` | **Pinned** | Required on `WorkflowReviewRequestWorkflowRepository`. |
| `findByRequestId(requestId, ctx)` | **Pinned** | Required on the child repository. |
| `packages/@n8n/db/src/entities/index.ts` and `repositories/index.ts` exports | **Pinned** | Required because tests and consumers import the entity/repository classes through `@n8n/db`. |
| REST controller under `/workflow-review-requests` | Route surface **Pinned**, filename/class **Under-pinned** | Must expose the eight routes in §3. Static routes must not be swallowed by `/:id`. |
| Domain/application service | **Required-integration** | Must own authorization, transitions, detail assembly, approval, publication, and collaboration invalidation. Its filename and public methods are not pinned. |
| Publish-guard provider implementing `WorkflowPublishGuard` | **Pinned interface**, **Required-integration implementation** | Must register with [workflow-publish-guard-proxy.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/workflows/workflow-publish-guard-proxy.service.ts:8). |
| Lifecycle provider implementing `WorkflowMutationHooks` | **Pinned interface**, **Required-integration implementation** | Must register all four hooks from [workflow-mutation-hooks-proxy.service.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/workflows/workflow-mutation-hooks-proxy.service.ts:15). |
| Integration test-server import | **Pinned** | [test-server.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/shared/utils/test-server.ts:364) currently points to a purged `.ee` module and must point to the clean module. The endpoint and module groups already include `workflow-reviews`. |
| `DEFORK_CHANGELOG.md` entry | **Required by fork policy** | Must record the surviving fair-code sources used for the clean-room implementation. |

All database access must remain in `@n8n/db` repositories, use use-case-named methods, accept `OperationContext`, and use `TransactionRunner` for multi-row transitions.

## 2. Authoritative database schema

The authoritative definition is [1784000000052-CreateWorkflowReviewRequestTables.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/migrations/common/1784000000052-CreateWorkflowReviewRequestTables.ts:48). It creates four tables.

### `workflow_review_request`

| Column | Type | Null | Default/constraint |
|---|---|---:|---|
| `id` | `varchar(36)` | No | Primary key |
| `projectId` | `varchar(36)` | No | FK → `project.id`, `ON DELETE CASCADE` |
| `state` | `varchar(16)` | No | Default `'open'`; check: `open`, `closed` |
| `decision` | `varchar(50)` | No | Default `'pending'`; check: `pending`, `changes_requested`, `approved` |
| `title` | `varchar(255)` | No | API further restricts this to 128 characters |
| `description` | `text` | Yes | API further restricts this to 512 characters |
| `createdById` | UUID | Yes | FK → `user.id`, `ON DELETE SET NULL` |
| `updatedById` | UUID | Yes | FK → `user.id`, `ON DELETE SET NULL` |
| `closedById` | UUID | Yes | FK → `user.id`, `ON DELETE SET NULL` |
| `approvedAt` | timezone-aware timestamp | Yes | PostgreSQL `timestamptz(3)` equivalent |
| `createdAt` | timezone-aware timestamp | No | Added by `withTimestamps`, current-timestamp default |
| `updatedAt` | timezone-aware timestamp | No | Added by `withTimestamps`, current-timestamp default |

Index:

```text
workflow_review_request_project_state (projectId, state)
```

### `workflow_review_request_workflow`

| Column | Type | Null | Constraint |
|---|---|---:|---|
| `id` | `varchar(36)` | No | Primary key |
| `workflowReviewRequestId` | `varchar(36)` | No | FK → request, `ON DELETE CASCADE` |
| `workflowId` | `varchar(36)` | No | FK → `workflow_entity.id`, `ON DELETE CASCADE` |
| `workflowVersionId` | `varchar(36)` | Yes | FK → `workflow_history.versionId`, `ON DELETE SET NULL` |

Indexes:

```text
UNIQUE (workflowReviewRequestId, workflowId)
(workflowId, workflowReviewRequestId)
```

The nullable version pin is deliberate: pruning a closed review’s history leaves the review row intact but clears its pin.

### `workflow_review_request_reviewers`

| Column | Type | Null | Constraint |
|---|---|---:|---|
| `workflowReviewRequestId` | `varchar(36)` | No | Composite PK; FK → request, cascade |
| `userId` | UUID | No | Composite PK; FK → user, cascade |

Additional index:

```text
(userId, workflowReviewRequestId)
```

This specifically supports “assigned to me” lookup.

### `workflow_review_request_authors`

| Column | Type | Null | Constraint |
|---|---|---:|---|
| `workflowReviewRequestId` | `varchar(36)` | No | Composite PK; FK → request, cascade |
| `userId` | UUID | No | Composite PK; FK → user, cascade |

There is no reverse author index.

### What the schema does not enforce

These are service/repository obligations or open design choices:

- No unique constraint prevents two open reviews for the same workflow.
- No constraint couples `state`, `decision`, and `approvedAt`.
- No constraint says an approved request must be closed.
- The schema permits several workflows per request; the current DTO requires exactly one.
- The schema permits arbitrary closed decisions, including `closed/pending`.
- It does not record one decision per reviewer; there is only one request-level decision.

The [344-line migration test](/home/ggrace/linux-coding/n8n/packages/cli/test/migration/1784000000052-create-workflow-review-request-tables.test.ts:116) pins table/index existence, insertion, reads, and parent-deletion cascades. It does not exhaustively assert every default, enum check, or every FK deletion policy.

## 3. Full REST surface

The exact frontend caller is [workflowReviews.api.ts](/home/ggrace/linux-coding/n8n/packages/frontend/editor-ui/src/features/workflow-reviews/workflowReviews.api.ts:27). These are the backend routes it requires.

n8n’s REST client unwraps the conventional outer `{ data: logicalResponse }` envelope. Shapes below are the logical controller results.

### Shared response types

```ts
type WorkflowReviewRequestSummary = {
	id: string;
	state: 'open' | 'closed';
	decision: 'pending' | 'changes_requested' | 'approved';
	workflowVersionId: string | null;
	createdAt: Iso8601DateTimeString;
	updatedAt: Iso8601DateTimeString;
};

type WorkflowReviewEligibleReviewer = {
	id: string;
	email: string;
	firstName: string | null;
	lastName: string | null;
};
```

### Routes

| Method and path | Request | Logical response | Corroboration |
|---|---|---|---|
| `GET /workflow-review-requests` | Query: `{ workflowId: string; state?: 'open' \| 'closed'; take?: number; skip?: number }` | `WorkflowReviewRequestList` below | Exact frontend client and `ListWorkflowReviewRequestsQueryDto` |
| `GET /workflow-review-requests/eligible-reviewers` | Query: `{ workflowId: string }` | `{ count: number; data: WorkflowReviewEligibleReviewer[] }` | Exact frontend client and eligible-reviewer DTO |
| `POST /workflow-review-requests` | `CreateWorkflowReviewRequestDto` below | `WorkflowReviewRequestSummary` | Exact frontend client and create DTO |
| `POST /workflow-review-requests/:workflowReviewRequestId/update-version` | `UpdateWorkflowReviewRequestVersionDto` below | `WorkflowReviewRequestSummary` | Exact frontend client and update DTO |
| `POST /workflow-review-requests/:workflowReviewRequestId/decision` | `{ decision: 'approved' \| 'changes_requested' }` | `DecideWorkflowReviewRequestResponse` below | Exact frontend client and decision DTO |
| `GET /workflow-review-requests/summary` | None | `{ open: number; closed: number }` | Exact frontend client and inbox DTO |
| `GET /workflow-review-requests/inbox` | Query: `{ state?: 'open' \| 'closed'; limit?: number; cursor?: string }` | `ListWorkflowReviewInboxResponse` below | Exact frontend client and inbox DTO |
| `GET /workflow-review-requests/:workflowReviewRequestId` | None | `WorkflowReviewRequestDetail` below | Exact frontend client and detail DTO |

Exact create payload:

```ts
{
	title: string; // trim, 1..128
	description?: string; // max 512
	workflows: [{
		workflowId: string; // 1..36
		workflowVersionId: string; // 1..36
		workflowVersionName: string; // trim, 1..128
		workflowVersionDescription?: string; // max 2048; empty/whitespace clears it
	}]; // exactly one element
	reviewerUserIds?: string[]; // each 1..36, max 10
}
```

Exact update-version payload:

```ts
{
	workflowId: string;
	workflowVersionId: string;
	workflowVersionName: string;
	workflowVersionDescription?: string;
}
```

Workflow-scoped list:

```ts
type WorkflowReviewRequestForWorkflow = WorkflowReviewRequestSummary & {
	decisionBy: WorkflowReviewEligibleReviewer | null;
	approvedVersionPublicationState:
		| 'published'
		| 'superseded'
		| 'not_published'
		| 'unknown'
		| null;
};

type WorkflowReviewRequestList = {
	count: number;
	data: WorkflowReviewRequestForWorkflow[];
};
```

`approvedVersionPublicationState` is `null` unless the review is approved. Workflow-status synchronization calls this route with `take: 1` and treats `data[0]` as the latest review, so newest-first ordering is **Required-integration**.

Decision response:

```ts
type DecideWorkflowReviewRequestResponse = WorkflowReviewRequestSummary & {
	autoPublish?:
		| { status: 'published' }
		| { status: 'failed'; message: string };
};
```

`autoPublish` is present only for approval. A failed publication must not undo the approval.

Inbox:

```ts
type WorkflowReviewInboxItem = WorkflowReviewRequestSummary & {
	projectId: string;
	title: string;
	workflowName: string | null;
	requester: WorkflowReviewEligibleReviewer | null;
	reviewers: WorkflowReviewEligibleReviewer[];
};

type ListWorkflowReviewInboxResponse = {
	data: WorkflowReviewInboxItem[];
	nextCursor: string | null;
	hasMore: boolean;
};
```

DTO constraints:

- `limit`: coerced integer, 1–100, default 15.
- `cursor`: opaque base64url keyset cursor, maximum 256 characters, representing `(createdAt ISO string, id)`.
- Omitted `state` is documented to mean `open`.

Detail:

```ts
type WorkflowReviewVersionSnapshot = {
	versionId: string;
	name: string | null;
	nodes: INode[];
	connections: IConnections;
	nodeGroups: IWorkflowGroup[];
	createdAt: Iso8601DateTimeString;
};

type WorkflowReviewRequestWorkflowDetail = {
	workflowId: string;
	workflowName: string;
	workflowVersionId: string | null;
	pinnedVersion: WorkflowReviewVersionSnapshot | null;
	baselineVersion: WorkflowReviewVersionSnapshot | null;
};

type WorkflowReviewRequestDetail = WorkflowReviewInboxItem & {
	description: string | null;
	workflows: WorkflowReviewRequestWorkflowDetail[];
	viewerCanDecide: boolean;
	viewerDecisionIneligibilityReason:
		| 'author'
		| 'missing_publish_permission'
		| null;
};
```

`baselineVersion` is the latest published version resolved at read time; `null` means the workflow has never been published. Eligibility is advisory and deliberately ignores request lifecycle; the decision endpoint must recheck both identity and state.

Frontend behavior additionally pins:

- Creating while another open review exists produces HTTP `409`.
- Status reads tolerate `403`/`404` when access or feature availability disappears.
- A concurrent/stale second decision must be rejected rather than overwrite an earlier result; the component expects `409`.
- Approval publishes the pinned version, not the current working version.
- Approved-but-unpublished is a retryable state using the ordinary publish flow.

## 4. Repository contract

### Exact surviving repository API

From [workflow-history.repository.test.ts](/home/ggrace/linux-coding/n8n/packages/cli/test/integration/database/repositories/workflow-history.repository.test.ts:351):

```ts
WorkflowReviewRequestRepository.createRequest(
	{
		projectId: string;
		title: string;
		createdById: string | null;
		state?: 'open' | 'closed';
	},
	ctx: OperationContext,
): Promise<WorkflowReviewRequest>;

WorkflowReviewRequestWorkflowRepository.createWorkflowRow(
	{
		workflowReviewRequestId: string;
		workflowId: string;
		workflowVersionId: string | null;
	},
	ctx: OperationContext,
): Promise<WorkflowReviewRequestWorkflow>;

WorkflowReviewRequestWorkflowRepository.findByRequestId(
	requestId: string,
	ctx: OperationContext,
): Promise<WorkflowReviewRequestWorkflow[]>;
```

Parameter details beyond those exercised are under-pinned, but these calls must compile and behave as shown.

### Additional required repository capabilities

The application service will need use-case-named methods for:

- Atomically finding/creating the one open request for a workflow.
- Loading a request with workflow links, authors, reviewers, requester, and decision actor.
- Workflow-scoped newest-first listing with count.
- Inbox count and keyset pagination.
- Finding eligible reviewers from project/workflow permissions.
- Updating the pinned version and workflow-history metadata transactionally.
- Applying a conditional transition only while `state = 'open'`.
- Closing open reviews for lifecycle mutations.
- Finding all affected workflow IDs for post-commit broadcasts.
- Maintaining reviewer and author junctions.

The exact method names are **Under-pinned**. Generic TypeORM options must not leak into the service layer.

### Workflow-history pruning

The surviving test pins this rule:

- Versions pinned by an **open** review survive pruning even if named-version preservation is disabled.
- A closed review no longer protects its pinned version.
- If that version is pruned, the child FK sets `workflowVersionId` to `null`.

The current [WorkflowHistoryRepository](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/repositories/workflow-history.repository.ts:51) does not exclude open-review pins. The rebuild must add that exclusion.

### Publication-state repository

[WorkflowPublishHistoryRepository.getVersionPublicationStates](/home/ggrace/linux-coding/n8n/packages/@n8n/db/src/repositories/workflow-publish-history.repository.ts:53) is already implemented and is an exact integration contract:

```ts
getVersionPublicationStates(
	workflowId: string,
	versionIds: string[],
): Promise<Map<string, 'published' | 'superseded' | 'not_published' | 'unknown'>>;
```

Semantics:

- Deduplicates inputs; empty input returns an empty map.
- Missing workflow-history row → `unknown`.
- Exact version has an `activated` event → `published`.
- A newer history version has an `activated` event → `superseded`.
- Otherwise → `not_published`.
- Deactivation does not undo published/superseded status.
- Uses a fixed query count rather than N+1 queries.

The review listing service must call this for approved requests. A null pin must be synthesized as `unknown`.

## 5. Service, policy, eligibility, and approval contract

### Effective feature state

Three independent states survive:

```text
available = license has feat:workflowReviews
         && N8N_ENV_FEAT_WORKFLOW_REVIEWS === "true"

enabled = available
       && persisted security.workflowReviews policy is true
```

[WorkflowReviewPolicyService](/home/ggrace/linux-coding/n8n/packages/cli/src/services/workflow-review-policy.service.ts:8) pins:

- Missing, malformed JSON, or schema-invalid setting → `{ enabled: false }`.
- Writes upsert `security.workflowReviews` with `loadOnStartup: true`.
- Invalid values produce `UserError('Invalid workflow reviews settings')`.

### State transitions

| Operation | Required result | Strength |
|---|---|---|
| Create | Create request as `open/pending`, link exactly one workflow and pinned version, preserve version metadata, attach requester/authors and optional reviewers | **Required-integration** |
| Duplicate create | Reject if an open request already exists for that workflow, HTTP `409` | **Pinned by frontend** |
| Request changes | Set decision to `changes_requested`; request remains open | **Required-integration** |
| Update version | Replace the pin and version metadata; remain open | **Pinned payload/result** |
| Update after changes requested | Reset decision to `pending` | **Strongly implied, not directly tested** |
| Approve | Atomically set `decision = approved`, `state = closed`, `approvedAt`, `closedById`/decision actor | **Required-integration** |
| Approve publication | After approval commits, attempt to publish the pinned version | **Required-integration** |
| Publish failure | Preserve approval and return `{status:'failed', message}` | **Pinned** |
| Lifecycle closure | Close open reviews when linked workflow is archived, transferred to another project, or deleted | **Pinned by manifest rationale and lifecycle interfaces** |

The approval must commit before auto-publication. Otherwise the publish guard would see the same request as open and block its own approved version. Publication failure is therefore a post-decision outcome, not a transaction rollback.

### Decision eligibility

The detail DTO’s closed reason union strongly pins two eligibility rules:

1. An author may not decide their own review.
2. The decision maker must have `workflow:publish` for the linked workflow.

The endpoint must recheck both rules and request lifecycle at submission time.

Being assigned in the reviewers junction is probably not an authorization requirement: reviewers are optional, and there is no `not_assigned` in the closed ineligibility union. That conclusion is **Required-integration inference**, not directly tested.

The eligible-reviewers endpoint should therefore return users who can publish the workflow and are not authors. Exact ordering, search scope, and whether inactive/pending users are excluded are under-pinned.

### Publish guard

When the effective feature is enabled:

- An open `pending` review must throw `WorkflowPublishBlockedError` with reason `review_pending`.
- An open `changes_requested` review must throw with reason `changes_requested`.
- Details must contain the blocking `workflowReviewRequestId`.
- The existing error maps this to HTTP `409`.

When the provider is absent, disabled, or the feature is unavailable, the proxy permits publication. Behavior for previously open reviews after policy disablement is under-pinned, but the least surprising contract is to leave their data intact while disabling enforcement.

### Collaboration invalidation

After a transaction commits, every create, update-version, decision, and lifecycle close affecting a workflow must call:

```ts
CollaborationService.broadcastWorkflowReviewStateChanged(workflowId)
```

The surviving [collaboration implementation](/home/ggrace/linux-coding/n8n/packages/cli/src/collaboration/collaboration.service.ts:322) pins:

- Recipients are current workflow collaborators.
- No collaborators means no message.
- Exact push message:

```ts
{
	type: 'workflowReviewStateChanged',
	data: { workflowId },
}
```

This is invalidation-only; clients refetch authoritative state.

## 6. Other integration points

### Security settings

[security-settings.controller.ts](/home/ggrace/linux-coding/n8n/packages/cli/src/controllers/security-settings.controller.ts:13) pins:

- Root path: `/settings/security`.
- Global scope: `securitySettings:manage`.
- Controller-level `feat:personalSpacePolicy` license gate remains in force.
- `workflowReviews` is included in GET only when workflow reviews are license-and-env available.
- POST touching `workflowReviews` is forbidden when unavailable.
- A changed value is persisted through `WorkflowReviewPolicyService`.
- A real change emits:

```ts
{
	settingName: 'workflow_reviews',
	value: boolean,
}
```

No persistence or event occurs when the value is unchanged.

### Frontend settings

[frontend-settings.ts](/home/ggrace/linux-coding/n8n/packages/@n8n/api-types/src/frontend-settings.ts:50) requires:

```ts
enterprise.workflowReviews: boolean;
workflowReviews?: { enabled: boolean };
```

[FrontendService](/home/ggrace/linux-coding/n8n/packages/cli/src/services/frontend.service.ts:555) must:

- Set `enterprise.workflowReviews` from the license.
- Include `workflowReviews` policy only when license and environment flag make the feature available.
- Delete/omit the optional policy object otherwise.
- Reload the policy on every settings fetch rather than relying on a stale snapshot.

The frontend computes availability from license + environment and enabled state from the policy.

### Ownership transfer and lifecycle

The manifest’s stale entry is at [ownership-transfer.manifest.json](/home/ggrace/linux-coding/n8n/packages/cli/src/services/ownership-transfer/ownership-transfer.manifest.json:68). The rebuild must:

- Register an entity literally named `WorkflowReviewRequest`.
- Update the manifest to its clean declaring file.
- Keep it marked “not transferred with the project.”
- Retain the `projectId` relation so the manifest test recognizes it as project-owned.
- Let source-project deletion remove requests through the `projectId` cascade.
- Close open reviews when the workflow is moved, archived, or deleted.

Important surviving wiring defect: `afterWorkflowsTransferred(workflowIds)` exists in the proxy, but there is no production caller. Rebuilding the provider alone will not satisfy transfer closure; the workflow-transfer flow must invoke the hook after commit.

### Test server

The integration harness already accepts both:

```ts
endpointGroups: ['workflow-reviews']
modules: ['workflow-reviews']
```

Only its import still points to the purged module directory.

## 7. Permissions, scopes, and license gating

There is no `workflowReview:*` or similarly bespoke scope in `@n8n/permissions`; exhaustive `workflowReview` search returns zero matches.

Surviving applicable scopes are:

- `workflow:read`
- `workflow:update`
- `workflow:publish`
- `workflow:unpublish`
- global `securitySettings:manage`

Strongly pinned:

- Decisions require `workflow:publish`.
- Security-policy management requires `securitySettings:manage`.
- Authors cannot decide even if they can publish.
- Personal-workflow settings may conditionally remove publish/unpublish permission, so eligibility must use resolved permissions rather than role-name checks.

Under-pinned:

- Exact scope for create and update-version.
- Whether inbox/detail/list require only `workflow:read` or a stronger scope.
- Cross-project inbox visibility rules.

Recommended authorization mapping:

- List/detail/inbox/summary: only requests whose workflows the caller can `workflow:read`.
- Create/update-version: `workflow:update` plus `workflow:publish`, matching the surviving submit-for-publication UI.
- Decision: `workflow:publish` and not an author.
- Eligible reviewers: expose only users who can `workflow:publish` and are not authors.
- Never rely on the frontend gate as authorization.

License feature: `feat:workflowReviews`.

Environment gate: only exact lowercase string `N8N_ENV_FEAT_WORKFLOW_REVIEWS=true`.

Policy key: `security.workflowReviews`.

## 8. Recommendation: rebuild, do not remove

**Recommendation: rebuild the backend module.**

Although endpoint-level backend specs were purged, this is not an uncontracted feature:

- The complete authoritative database migration survives.
- Seven DTOs and their validation tests survive.
- The complete frontend route client and state/component behavior survive.
- Publish blocking, lifecycle hooks, collaboration invalidation, settings, permissions, publication-state derivation, ownership handling, and test-server registration all survive.
- A workflow-history integration test already encodes repository names and pin-retention behavior.

The missing endpoint spec is test debt. It does not erase the system contract.

A rebuild should include:

1. The two ORM entities plus reviewer/author mappings.
2. Exact exported repository classes and pinned repository methods.
3. The clean backend-module entry.
4. Controller and service for all eight routes.
5. Transactional create/update/decision/lifecycle operations.
6. Publish-guard and mutation-hook providers.
7. Workflow-history pruning protection for open pins.
8. Clean test-server and ownership-manifest references.
9. New endpoint/service tests derived exclusively from the surviving DTO/client behavior.
10. `DEFORK_CHANGELOG.md` provenance documentation.

Removal would be substantially broader and riskier. A complete removal would have to unwind the REST DTOs, frontend feature, settings surfaces, policy storage, module registration, push message, collaboration helper, publish/mutation proxies, blocked-publication error contract, publication-state API, repository integration test, migration/test, and ownership metadata. Because the migration may already have run in deployed databases, removal would also need a new forward migration; editing or pretending the existing migration never existed would be unsafe.

That breadth makes removal a product deprecation and data-migration project, not a simpler de-fork cleanup.

## 9. Open and under-pinned areas

The rebuild needs explicit decisions and new tests for:

1. **Single-open-review concurrency.** HTTP `409` is pinned, but the migration has no race-safe uniqueness constraint. Decide between transactional locking and a new forward uniqueness migration.
2. **Update transition.** Resetting `changes_requested` to `pending` is strongly implied but not directly asserted.
3. **Author population.** The author junction exists, but surviving workflow history stores display authors rather than user IDs. Which users become authors is not pinned.
4. **Requester semantics.** `createdById` clearly supplies the inbox requester, but treatment after user deletion and whether the requester is always an author need tests.
5. **Reviewer assignment.** Reviewer display is pinned; assignment as authorization is not and appears intentionally absent.
6. **Inbox visibility and ordering.** Cursor composition is pinned, but exact descending order, project filtering, and assigned-reviewer filtering are not.
7. **Lifecycle close values.** Closure is required, but surviving sources do not specify resulting decision, `closedById`, or whether `updatedById` is null.
8. **Policy disablement.** Whether existing open reviews remain visible/actionable when disabled is not directly specified.
9. **Error surface.** Create and stale decision `409`, status-read `403/404`, and publish-block `409` are pinned; remaining not-found/conflict/authorization mappings are not.
10. **Baseline tie-breaking.** “Latest published at read time” is pinned, but equal-timestamp ordering and pruned publication history need deterministic handling.
11. **Multiple workflows.** Schema supports them, but the current API accepts exactly one. Implement for one while keeping repository structure compatible with the schema.
12. **Transfer hook wiring.** The provider interface exists but has no production invocation.
13. **Migration-test gaps.** Reviewer cascade, user `SET NULL`, version `SET NULL`, project cascade, defaults, and enum checks deserve explicit coverage.
14. **No surviving endpoint spec.** Every route, authorization rule, transition, concurrency path, and auto-publish outcome needs new clean-room tests before considering the rebuild complete.

## Verification evidence

- Workflow-review DTO tests: **38/38 passed**.
- SQLite migration test: **4/4 passed**.
- Collaboration and security-settings integration tests: **27/27 passed**.
- Isolated frontend-settings workflow-review refresh test: **passed**.
- Ownership manifest test: **2 expected failures**, identifying missing `WorkflowReviewRequest` metadata and the stale purged-file path.
- Workflow-history repository integration test: **7 expected setup failures**, all blocked by missing `WorkflowReviewRequestWorkflow` entity metadata; this confirms the rebuild obligation before the pin-retention assertion can execute.
- Worktree remained clean, and local `HEAD` matched `origin/master` at `cd250fc9c0cd`.