# Task: extract the FULL contract for rebuilding n8n's purged source-control (git sync) backend (read-only analysis)

You are analyzing the n8n monorepo at the current directory. The enterprise `source-control.ee` module was deleted (files gone; git history purged too — do NOT try to recover it). We rebuild clean-room from surviving fair-code sources. Produce a precise contract inventory so an implementer can write the replacement without guessing.

## Already-rebuilt fair-code pieces (read them; do not re-spec what exists)
- `packages/cli/src/modules/source-control/source-control-preferences.service.ts` + `types/source-control-preferences.ts`

## Evidence sources (read ALL, exhaustively)
1. The five surviving integration specs — THE core spec, 4,745 lines total:
   - `packages/cli/test/integration/environments/source-control.service.test.ts` (1608)
   - `packages/cli/test/integration/environments/source-control-import.service.test.ts` (2019)
   - `packages/cli/test/integration/environments/source-control-export.service.test.ts` (651)
   - `packages/cli/test/integration/environments/source-control.api.test.ts` (283)
   - `packages/cli/test/integration/environments/source-control-access-control.test.ts` (184)
   Extract every imported symbol + path (they name the module files to rebuild), every service method signature/behavior they pin, REST routes with status codes + verbatim bodies/messages, file-format expectations (exported JSON file shapes, directory layout under the git work folder), RBAC pins, and license gates.
2. `packages/cli/src/public-api/v1/handlers/source-control/source-control.handler.ts` + its imports (`source-control-helper.ee` symbols, `SourceControlService` methods used) + the public-api spec if one exists (search `test/integration/public-api/` for source-control/pull).
3. All other consumers: `packages/cli/src/modules/data-table/middleware/branch-write-access-middleware.ts`, `data-table.controller.ts`, `data-table-proxy.service.ts`, `packages/cli/src/modules/instance-ai/instance-ai.service.ts` + `instance-ai.adapter.service.ts`, telemetry/pubsub event maps (`relay.event-map.ts`, `telemetry.event-relay.ts`, `pubsub.event-map.ts`, `pubsub.types.ts`, `telemetry/index.ts`) — extract each referenced symbol, event name/payload, and how it's used.
4. `@n8n/api-types` source-control DTOs/schemas (grep for sourceControl / source-control in packages/@n8n/api-types/src) — request/response pins.
5. Frontend/rest-api-client pins: grep packages/frontend and packages/@n8n/rest-api-client for source-control API calls (routes, payloads). Also `packages/@n8n/i18n` keys only if they reveal flows (low priority).
6. `@n8n/db` entities/types the module needs (grep for SourceControl / git in packages/@n8n/db/src; also `@n8n/config` source-control config sections; the `features.sourceControl`-style settings rows if referenced).
7. `@n8n/backend-test-utils` helpers the specs use (createWorkflow etc. plus any source-control-specific fixtures under test/integration/environments/ or shared dirs — list fixture files).
8. Which git library the specs/mocks expect (grep imports in the specs: simple-git? isomorphic-git? ssh key handling — search for ssh/ed25519/rsa key generation pins).
9. Run `grep -rn "source-control.ee\|sourceControl" packages/cli/src --include='*.ts' -l | grep -v test` and cover every file.

## Output format (markdown, exhaustive, verbatim where pinned)
1. **Module file map**: every `source-control.ee/*` path referenced anywhere, with the symbols each must export.
2. **SourceControlService contract**: every method (signature, semantics, status transitions, error classes/messages).
3. **Export service contract**: what gets written where (directory layout, file naming, JSON shapes — verbatim from the 651-line spec).
4. **Import service contract**: the 2019-line spec is the crown jewel — pin ALL behaviors (variables/credentials/workflows/folders/tags import semantics, conflict handling, ownership assignment, deletion rules).
5. **REST routes** (internal controller) + **public-api routes**: method+path, auth scopes, license gates, bodies, status codes, verbatim messages.
6. **Helper functions** (`source-control-helper.ee` etc.): signatures + behavior.
7. **Preferences/connect flow**: what beyond the existing preferences service is pinned (ssh key generation/types, connect/disconnect, branch listing).
8. **Events/telemetry/pubsub**: names + payloads the module must emit/handle.
9. **DTO/api-types + frontend pins**.
10. **Open questions / under-pinned areas** — list explicitly rather than guessing.
