# Innovation Proposals — n8n de-fork (AI-native, fair-code)
*Generated 2026-08-08 · based on commit 636c44ed0e (post-purge)*

## How this codebase stands today
A forked n8n with **all Enterprise (`.ee`) code surgically removed** from tree and
history — a clean fair-code base. The workflow engine, ~1,000 node types, the
Vue 3 editor, and — critically — most of the **AI substrate survived the purge**:
`@n8n/instance-ai` (assistant backend), `@n8n/workflow-sdk` (programmatic workflow
construction), `@n8n/ai-node-sdk`, `@n8n/nodes-langchain` (~70 LangChain nodes),
and MCP servers (`@n8n/mcp-apps`, `@n8n/mcp-browser`, plus a local MCP server stack
in `cli/src/modules/instance-ai/`). What was licensed-and-removed is the *specific*
AI Workflow Builder (`ai-workflow-builder.ee`) and the cloud proxy it phoned home to.
So the opportunity is unusually strong: rebuild the AI layer **fair-code and
local-first**, and go past what upstream shipped.

## What the best in this space are doing
- **Text-to-workflow** is now table stakes: n8n's own AI Builder, plus Make, Zapier,
  and Gumloop all generate workflows from natural language and let you refine them
  ([n8n 2026 guide](https://hatchworks.com/blog/ai-agents/n8n-guide/),
  [self-hosted AI](https://dancumberlandlabs.com/blog/n8n-ai-workflows/)).
- **Native MCP** is the connective tissue of 2026 automation — n8n ships MCP support
  and elite admin tooling exposes operations as MCP servers
  ([Microsoft Ignite 2025](https://www.microsoft.com/en-us/microsoft-365/blog/2025/11/18/microsoft-ignite-2025-copilot-and-agents-built-to-power-the-frontier-firm/)).
- **Intent-driven administration**: the Microsoft 365 Admin agent lets admins run
  the platform through natural language over MCP, shifting from manual config to
  intent ([M365 Admin agent](https://learn.microsoft.com/en-us/microsoft-365/copilot/copilot-ai-admin-agent)).
  Almost nobody does this for self-hosted OSS automation — a clear gap to own.
- **Local-first / BYO-model** is the differentiator for self-hosters who chose to
  self-host for privacy and cost control.

## Proposals (ranked)

### 1. Instance Copilot — intent-driven settings & admin agent
**Category:** wow · **Impact 5 · Novelty 5 · Effort 3 · Fit 5**
**The idea.** A chat surface where an operator says "enforce MFA for all admins,
turn on execution data pruning at 30 days, and create a *Marketing* project with
Jane as editor" and the agent proposes a concrete, **dry-run** change set, shows a
diff, and applies it only on confirm. Every tool call is gated by the exact RBAC
scope we're rebuilding (`securitySettings:manage`, `user:enforceMfa`,
`project:create`, …) and written to an audit log. This is the "set app settings for
the user" vision, done safely.
**Inspired by.** [M365 Admin agent](https://learn.microsoft.com/en-us/microsoft-365/copilot/copilot-ai-admin-agent) (intent-driven admin over MCP).
**Implementation sketch.** New backend module `cli/src/modules/instance-copilot/`
exposing admin *tools* (typed, zod-validated) that wrap existing services
(settings, users, projects, pruning). An agent loop (reuse `@n8n/instance-ai`) with
structured tool-calling; a `plan → confirm → apply` protocol returning a change
diff. Enforce every tool with the rebuilt `hasGlobalScope(...)`. Surface as a
frontend drawer. Reuse the MCP local-server plumbing so the same tools are callable
from external MCP clients too.
**Effort.** ~3–4 days. Risk: destructive actions — mitigated by mandatory dry-run +
scope checks + audit.
**First step.** Define the tool schema + `plan/apply` types in `@n8n/api-types`; wrap
one safe setting (execution pruning) end-to-end.

### 2. AI Workflow Composer — fair-code NL → workflow
**Category:** feature · **Impact 5 · Novelty 3 · Effort 4 · Fit 5**
**The idea.** Rebuild the purged AI Builder as fair-code: describe an automation and
the Composer emits a real workflow using `@n8n/workflow-sdk`, then supports
*iterative patching* ("add a Slack alert on failure") as structured edits, not full
regen. Grounded by retrieval (proposal #4) so it picks real nodes/params.
**Inspired by.** Upstream n8n AI Builder + the surviving `workflow-sdk`; structured/
constrained generation best practice.
**Implementation sketch.** `cli/src/modules/ai-composer/`; generation constrained to
a JSON schema derived from the SDK; validate every candidate by *dry-loading* it
through the workflow parser before returning; diff-based apply into the editor.
Model-agnostic via proposal #7.
**Effort.** ~4–6 days. Risk: hallucinated node params — mitigated by RAG + parse-time
validation + auto-repair loop.
**First step.** A backend endpoint that turns a prompt into an SDK script and
round-trips it through the parser; happy path for a 3-node workflow.

### 3. Native MCP control plane for the instance
**Category:** architecture · **Impact 4 · Novelty 4 · Effort 3 · Fit 5**
**The idea.** Expose the instance's own operations (workflow CRUD, execute, settings,
projects) as a first-class **MCP server**, so any MCP client (Claude, IDEs, the
Composer, the Copilot) drives n8n through one governed contract. Turns AI features
from bespoke code into clients of a single tool surface.
**Inspired by.** n8n's native MCP direction; MCP-as-admin-substrate (M365).
**Implementation sketch.** Build on `@n8n/mcp-apps` + the local MCP stack in
`modules/instance-ai/`. Register tools that call services directly; auth via API-key
scopes; the same registry powers #1 and #2.
**Effort.** ~3 days. Risk: authz surface — every tool scope-gated and audited.
**First step.** Stand up an MCP server exposing read-only `search_workflows` +
`get_workflow`, scope-checked.

### 4. Local node+workflow embedding index (RAG grounding)
**Category:** performance/feature · **Impact 4 · Novelty 3 · Effort 3 · Fit 5**
**The idea.** A local embedding index over all node types (name, params, docs) and the
user's existing workflows, so AI features retrieve the *right* nodes and mimic the
user's patterns — sharply cutting hallucination. Local-first (no data leaves the box).
**Inspired by.** RAG best practice; the MCP server's existing `search_nodes`.
**Implementation sketch.** SQLite + `sqlite-vec` (self-hosted-friendly) or an
in-process HNSW; embeddings via the BYO provider (#7), defaulting to a local model.
Index built at boot + incrementally on node/workflow change. Exposed as an MCP tool
consumed by #2 and #1.
**Effort.** ~3 days. Risk: index freshness — solved by change-event hooks.
**First step.** Embed the node catalog into `sqlite-vec` and expose a `find_nodes`
similarity tool.

### 5. Execution self-heal — AI explain-and-fix
**Category:** feature · **Impact 4 · Novelty 3 · Effort 2 · Fit 5** *(quick win)*
**The idea.** On a failed execution, an agent reads the error + node config + input
and proposes a concrete fix (a patched parameter, a missing mapping, a retry policy),
one-click applyable. The most-felt daily pain, directly addressed.
**Implementation sketch.** Hook the execution-error path; build a focused context
(error, node, upstream data sample) and ask for a structured patch validated against
the node's param schema before offering it. Reuse #7 for the model.
**Effort.** ~2 days. Risk: bad patches — always preview + validate, never auto-apply.
**First step.** "Explain this error" read-only endpoint on a failed execution.

### 6. Bring-your-own-model provider layer (incl. local Ollama)
**Category:** architecture · **Impact 4 · Novelty 2 · Effort 2 · Fit 5** *(quick win)*
**The idea.** One provider abstraction (Anthropic / OpenAI / **Ollama local**) that all
AI features (#1–#5) consume, configured per-instance. Privacy-preserving default for
self-hosters; removes the cloud-proxy dependency the purged builder had.
**Implementation sketch.** `@n8n/instance-ai` gains a `ModelProvider` interface +
adapters; config in `@n8n/config`; local Ollama default when reachable. Streaming +
tool-calling normalized across providers.
**Effort.** ~2 days. Risk: tool-calling parity across providers — capability-flag it.
**First step.** `ModelProvider` interface + Ollama adapter behind a config flag.

### 7. Guardrailed generation + LLM-as-judge eval suite
**Category:** ops · **Impact 3 · Novelty 3 · Effort 3 · Fit 4**
**The idea.** A structured-generation harness (schema-constrained + auto-repair) plus
an offline eval suite (golden prompts → judged workflow quality) so AI changes are
measured, not vibed. Keeps the Composer/Copilot from regressing.
**Implementation sketch.** Wrap generation in a validate-and-repair loop; eval runner
with a small golden set + programmatic + LLM-as-judge checks; wire into CI as a
non-blocking report first.
**Effort.** ~3 days. Risk: eval flakiness — pin seeds, judge with rubrics.
**First step.** 10 golden prompts + a parse-success + node-count check.

## Killed ideas (and why)
- **Rewrite the engine in Rust/Go** — rewrite in disguise; no problem behind it.
- **Ship our own foundation model** — absurd scope; BYO-model (#6) is the right lever.
- **Full cloud AI-credits marketplace** — re-creates the enterprise cloud dependency
  we just removed; against the fair-code, local-first goal.
- **Generic "add more tests/CI/docs"** — banned boilerplate; #7 is the specific,
  justified version.
- **Voice control of the editor** — wow-for-wow's-sake; no real user pull yet.

## Suggested order of attack
Everything in Phase C is **blocked on the green build** (finish `@n8n/permissions`,
then `ProjectService`, `@n8n/db`, core services). Once green: land **#6 (BYO-model)**
first — it unblocks all others and gives self-hosters local models immediately. Then
**#3 (MCP control plane)** and **#4 (RAG index)** as shared substrate, then the two
flagships **#2 (Composer)** and **#1 (Instance Copilot)** on top, with **#5 (self-heal)**
as an early quick win to show momentum and **#7 (evals)** guarding #2. Each ships on
its own `innovation/<slug>` branch.
