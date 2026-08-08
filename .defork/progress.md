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
