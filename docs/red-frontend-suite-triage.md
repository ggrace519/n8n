# editor-ui red unit-test suite — triage (2026-09-19)

> **RESOLVED 2026-09-30** (branch `fix/editor-vars-workflow-project`). The real root
> cause of clusters #1 *and* #2 was the clean-room `environments.store`: it scoped
> `$vars` by `projectsStore.currentProjectId`, which reads the route, so every NDV
> spec that auto-mocks vue-router crashed on `route.params`, and the half-mounted
> components leaked DOM ("found multiple elements"). The testing-library dom@9/@10
> split was a red herring. Scoping `$vars` by the edited workflow's home project
> (matching the backend's `getVariables`) cleared 130/136. Cluster #3 was resolved
> with Greg's product calls: custom-role project option "Create"; the
> highlighted-data dropdown rebuilt; evaluations shipped ungated; the paywall
> test-id aligned. Full editor-ui suite: green. The analysis below is kept as the
> original record.

**Status:** documented, not fixed. Greg's call: tackle as its **own session/branch**
(off `master`/`develop`), keep the dependency work (`verify/python-deps`) focused.

## Headline

`packages/frontend/editor-ui` has a **pre-existing red unit-test baseline**:
**18 test files / 136 tests fail**. This is **not** caused by the dependency-security
work and **not** specific to `verify/python-deps`:

- editor-ui `src/` is **byte-identical between `master` (`6998db67b1`, "Complete
  Phase A of the de-fork") and the pre-session branch tip `fb6a096c34`** — verified
  with `git diff master..fb6a096c34 -- packages/frontend/editor-ui/src/` (empty).
  So the same 136 tests fail on `master`.
- The dependency pass on `verify/python-deps` **reduced** failures by 3 (the faker
  `userName`→`username` fix); it added zero net-new failures (base 18/136 ≡ branch
  18/136 after that fix).

## Why CI never caught it

`ci-master.yml:29` → `test-unit-reusable.yml`, whose frontend job runs
`pnpm test:ci:frontend:changed ... --shard` (line ~227). Every test step in that
reusable workflow is a **`:changed`/affected variant** (`test:unit:changed`,
`test:ci:frontend:changed`, `test:changed`, `test:integration:changed`) driven by
`CHANGED_FILES` — there is **no full-suite frontend job**, on PRs *or* master.
Result: tests untouched since the Phase A de-fork rebuild were never in a changed
set, so they never ran green and the red baseline accumulated undetected.
(`test-e2e-coverage-nightly.yml` exists but is E2E, not these units.)

**Implication:** these tests likely **never passed on this fork** — this is
"port / rewrite / delete / fix the rebuilt code," not "repair a regression."

## Clusters (at least 3 distinct root causes — NOT one fix)

### Cluster #1 — `route` undefined (13 of 18 files) — harness
Error: `TypeError: Cannot read properties of undefined (reading 'params')`, origin
`src/features/collaboration/projects/projects.store.ts:60`
(`(route.params?.projectId ...)` — `useRoute()` returns `undefined` because the test
sets up `createTestingPinia` without a vue-router, so `route` itself is undefined;
line 64 `route.path.includes('home')` throws identically).
Files: useWorkflowHelpers, CredentialConfig, TemplatedAuthSimpleView, Assignment,
CollectionParameterLegacy, FixedCollectionParameterLegacy, FixedCollectionParameterNew,
ParameterInputExpanded, ParameterInputFull, ParameterInputWrapper, VirtualSchema,
ExperimentalNodeDetailsDrawer (+ partial in the collection cluster).

**NOT a one-line global mock.** `AssignmentCollection.test.ts` and `Assignment.test.ts`
already `vi.mock('vue-router')` and still fail — so a repo-wide `useRoute` stub would
not clear the cluster outright. The passing idiom is per-file
(`ResourceMapper.test.ts:703` mocks `vue-router` with a `useRoute` stub); scope the
work as "investigate why the existing mocks don't suffice," not "add one mock."
**Do NOT** make `projects.store.ts` defensive (`route?.params`) — that bends
production code to a test-harness gap and is incomplete (line 64 still throws).

### Cluster #2 — DOM duplication / not-cleaned (collection & parameter cluster)
Errors: `Found multiple elements by [data-test-id=...]`,
`Cannot read properties of null (reading 'nextSibling')`.
Files: AssignmentCollection, CollectionParameterNew, CollectionParameterLegacy,
CredentialConfig, ParameterInputFull, FixedCollectionParameterNew, ParameterInputExpanded.
**Lead to check first:** the failure stack printed `@testing-library+dom@9.3.4`, but
the frontend catalog declares `@testing-library/dom: ^10.4.0`. If
`@testing-library/vue@8.1.0` drags its own dom@9, two copies with two cleanup
registries → DOM accumulates across tests. Verify with a lockfile-key parse (NOT a
naive grep). If real, this is one mechanical fix for the whole cluster.

### Cluster #3 — content/assertion mismatches (product intent) — needs a decision
Tests assert values the current code no longer produces. On a clean-room RBAC rebuild,
which side is correct is a **product question**. Greg's call: **Claude proposes, Greg
confirms** before touching either side.
- `instanceRoleScopes.test.ts` — expects `INSTANCE_SCOPE_GROUPS.project` keys `['Create']`
  but the code yields `['Manage']`; also `option.descriptionKey` is falsy for some options.
  **Proposal:** `INSTANCE_SCOPE_GROUPS` is re-exported from `@n8n/permissions`
  (`GLOBAL_CUSTOM_ROLE_SCOPE_GROUPS`, `instanceRoleScopes.ts:12`). This file's local
  `DESCRIPTION_KEYS.project = { Create }` (line 81) and `OPTION_ORDER` (line 88) both
  expect a `Create` option — so the **`@n8n/permissions` side likely drifted** and
  should emit `Create` for `project`; the test looks correct. Needs cross-package
  verification before changing.
- `useWorkflowHelpers.test.ts` — `to deeply equal` mismatch (6 tests). Uninvestigated.
- `FocusSidebar.test.ts` — evaluations paywall element not rendered when unlicensed
  (`toBeInTheDocument()` on `evaluations-unlicensed`). Content/licensing-state mismatch.
- `NodesListPanel.test.ts` — expected 9 rendered trigger items, got 8. Content mismatch.
- `WorkflowExecutionsPreview.test.ts` — `Unable to find an element` (2 tests). Likely
  content/render mismatch; classify when worked.

## Method notes (so the next session doesn't re-derive)
- All 18 files fail **in isolation** too (ruled out pure parallel-pollution): see the
  per-file isolation run. So these are genuine, not ordering artifacts.
- To confirm "never green," build a `master` worktree FIRST (`pnpm build`, turbo) —
  a fresh worktree can't run vitest until `@n8n/vitest-config/dist` exists
  (`ERR_MODULE_NOT_FOUND` on `@n8n/vitest-config/frontend` otherwise).
- Recommended order when picked up: Cluster #2 (one dep fix, ~7 files) → Cluster #1
  (13 files, shared mechanism, investigate the mock gap) → Cluster #3 (per-case,
  propose-and-confirm).
