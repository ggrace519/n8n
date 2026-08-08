# De-fork + AI rebuild — progress log (append-only)

Newest last. Each entry: WHAT / WHY / NEXT. State of record is `feature_list.json`;
this file records the reasoning so the next session doesn't repeat dead ends.

---

## 2026-08-08 — Purge, guardrails, and Tier-0 foundation

**WHAT.**
- Detached the GitHub fork; purged all Enterprise (`.ee`) code from tree + full
  git history (`git filter-repo`, regex `\.ee(\.|/)`): 1,117 files / 22,535
  commits remain, 0 `.ee` reachable.
- Guardrails: hardened + enabled `no-import-enterprise-edition` (bans all `.ee`
  imports/re-exports/dynamic-imports), AGENTS.md fork policy, `DEFORK_CHANGELOG.md`.
- Fixed the only dangling workspace dep (`packages/cli` → purged
  `@n8n/ai-workflow-builder`); `pnpm install` green.
- Tier-0 `@n8n/permissions`: wrote `constants.ts` (RESOURCES catalog, 46
  resources/180 scopes) + `types.ts` (Scope/ApiKeyScope/role types). VERIFIED:
  `scope-information` snapshot passes byte-exact; `types.test` typechecks.
- Set up long-horizon state kit + `INNOVATIONS.md` (AI-native proposals).

**WHY.**
- Clean-room provenance requires the `.ee` source be *unreachable*, not just
  deleted — hence the history rewrite. The surviving package **test files** are
  fair-code and specify the deleted modules exactly, so we rebuild to pass them
  (spec + verification in one).

**KEY FACTS for the next session.**
- Rebuild order and status live in `feature_list.json`. Current front: finish
  `@n8n/permissions` (items A2–A6), each has a surviving fair-code test to verify.
- The AI foundation SURVIVED the purge (fair-code): `@n8n/instance-ai`,
  `@n8n/workflow-sdk`, `@n8n/ai-node-sdk`, `@n8n/mcp-apps`, `@n8n/mcp-browser`,
  `@n8n/nodes-langchain`, `packages/cli/src/modules/instance-ai/`. Only the
  licensed `ai-workflow-builder.ee` was purged → rebuild it fair-code (item C2).
- Per-role scope SETS (GLOBAL_OWNER_SCOPES etc.) are only partially pinned by
  tests → design community-equivalent (owner=all, graded down), satisfying every
  behavioral assertion. Do NOT read `.ee` history to recover them.
- TS here is tsgo/TS7: isolated typecheck uses `npx tsc --ignoreConfig ...`.
- Test harness needs `@n8n/vitest-config` built first
  (`pnpm --filter @n8n/vitest-config build`).

**NEXT.** Item **A2** — `@n8n/permissions/src/schemas.ts` (zod role schemas), verify
with `src/__tests__/schemas.test.ts`. Before writing, confirm consumer usage of
`Role`, `roleSchema`, `teamRoleSchema`, `assignableProjectRoleSchema`, `scopeSchema`.

## 2026-08-08 — @n8n/permissions fully rebuilt (A2–A6 done)

**WHAT.** Completed the entire `@n8n/permissions` package clean-room: schemas,
per-role scope sets + role-maps, all utilities, custom-role-scopes,
public-api-permissions, index rewrite, all-roles fix, all test imports repointed.
VERIFIED: typecheck clean + **105/105 tests pass**.

**WHY.** This is the Tier-0 foundation (172 consumers). Built to satisfy the
surviving fair-code tests (spec + verification in one). Per-role scope *contents*
were under-pinned by tests → designed community-equivalent; safe to tune later.

**KEY FACTS.**
- The noisy `import ... from '@n8n/permissions'` grep over-spanned statements —
  do NOT trust it as the barrel contract. Use the compiler: consumer typecheck at
  A10/A11 will name any missing barrel export (likely extras like GLOBAL_*_ROLE
  objects/slugs, isProjectRole, COUPLED_HIDDEN_SCOPES, getApiKeyScopesForRole).
- `pick/allOps` helper in `roles/scopes/scope-filters.ts` builds scope lists from
  RESOURCES; reuse it for any scope-set tuning.

**NEXT.** Item **A7** — `ProjectService` fair-code replacement
(`packages/cli/src/services/project.service.ee.ts` was purged; 49 consumers).
Recover its contract from consumers + surviving project.service tests, clean-room.

## 2026-08-08 — Downstream build unwiring (session continued)

**WHAT.** Full `pnpm build` now reaches 51/59 packages. Fixed blob-storage,
rest-api-client (dropped purged .ee barrel re-exports). Fixed a real permissions
bug: `Role` must be the role DTO object (`RoleObject`), not the slug string —
db's `builtInRoleToRoleObject` maps over `ALL_ROLES.*` (RoleObject[]). Added
`settings.ts` + `getApiKeyScopesForRole({role})` to permissions. db partially
unwired (entities + most repos done).

**WHY / GOTCHAS.**
- Stale TS `.tsbuildinfo` caused 22 phantom cascade errors (constants/tag/
  credentials createdAt) — ALWAYS `rm -rf dist *.tsbuildinfo .turbo` for a package
  before trusting its isolated build after a dependency's types change.
- Build in topological order via `pnpm build`; it halts at the first failing
  package (no --continue), so fix that one and re-run.

**NEXT (db-green, then cli).** Item **A8b**: strip execution-annotations from
`packages/@n8n/db/src/repositories/execution.repository.ts` (5 regions: imports,
serializeAnnotation, findSingleExecution, softDeletePrunableExecutions subquery,
and the toQueryBuilder/toQueryBuilderWithAnnotations/reduceExecutionsWithAnnotations
list flow). Verify with the surviving execution.repository tests + `pnpm --filter
@n8n/db build`. THEN item **A7** ProjectService (49 consumers) and the rest of cli
(worklist: scratchpad/dangling_files.txt — 73 source files).
