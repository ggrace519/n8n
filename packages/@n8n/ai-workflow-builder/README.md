# @n8n/ai-workflow-builder

Shared contracts and helpers for n8n's workflow-builder surfaces.

This package is **fair-code** and was rebuilt clean-room for this de-enterprised
fork. It replaces the purged `@n8n/ai-workflow-builder.ee`, deriving its shape
only from the surviving fair-code consumers in `packages/cli`, from
`@n8n/workflow-sdk`'s public exports, and from the editor-UI wire contract. No
enterprise-licensed source was consulted. See `DEFORK_CHANGELOG.md` for the full
provenance record.

## What's in here

| Area | Exports |
|---|---|
| **Tool descriptors** | The `{ toolName, displayTitle }` constants naming the workflow-builder tools, shared so the MCP server and the builder agent stay in lock-step. Also `SDK_IMPORT_STATEMENT`. |
| **Parse / validate** | `ParseValidateHandler`, `stripImportStatements`, `getWarningKey`, and a re-export of `ValidationWarning`. Thin orchestration over `@n8n/workflow-sdk` — the parsing and validation themselves live there. |
| **Session storage** | `ISessionStorage`, `StoredSession`, `LangchainMessage`, `isLangchainMessagesArray`. The contract `packages/cli`'s `WorkflowBuilderSessionRepository` implements. |
| **Builder service** | `AiWorkflowBuilderService`, `ChatPayload`, `ResourceLocatorCallbackFactory`, `createPassthroughSsrfGuard`. |

## The builder agent is not implemented in this fork

`AiWorkflowBuilderService` carries the real constructor, lifecycle, and session
handling, but the **LLM agent itself is absent**: `chat()` and
`getBuilderInstanceCredits()` throw `AiBuilderUnavailableError`.

This is deliberate and must stay loud. The routes in `ai.controller.ts` remain
registered behind `@Licensed('feat:aiBuilder')` (off by default), so the failure
is normally a 403; if the flag is ever enabled, the caller gets a clear error
rather than an empty-but-successful response. A silent stub here would be the
same class of defect as a permission constant that satisfies a check while
production takes a different path.

The fair-code agent is tracked separately as the AI Workflow Composer.
