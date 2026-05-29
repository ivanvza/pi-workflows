# Workflows

Code-driven multi-agent orchestration for pi. You define workflows in
`.pi/workflows/*.js`; **code handles the control flow, the model only handles
judgment inside each step.**

```
use code for what code is good at  → control flow (what runs, when, in parallel)
use models for what models are good at → judgment (the actual work of each step)
```

---

## Table of contents

- [The idea](#the-idea)
- [Why it matters: the token tax](#why-it-matters-the-token-tax)
- [Quick start](#quick-start)
- [Phase reference](#phase-reference)
- [Passing data between phases](#passing-data-between-phases)
- [Schemas](#schemas)
- [Agents](#agents)
- [Recipes & edge cases](#recipes--edge-cases)
- [Gotchas](#gotchas)
- [Running workflows](#running-workflows)
- [Programmatic / RPC integration](#programmatic--rpc-integration)

---

## The idea

A normal agent loop has the LLM do **two** different jobs:

| Job | What it is | Where it should live |
| --- | --- | --- |
| **Routing** — "plan the next step" | which sub-agent runs next, with what task, are we done yet | **code** |
| **Judgment** — do the step | the actual analysis/writing/reasoning of one step | **model** |

"Plans the next step" is the routing decision the orchestrator makes *every turn*.
In the old pattern the model makes it — re-reading the whole growing context each
time, non-deterministically. Workflows **move routing into code**: the `phases`
array is the plan, `condition`/`loop`/`map` are the branches. The model is invoked
*inside* a phase, never *between* phases to choose the route.

```js
// This loop IS the "plan". No model call decides what's next.
for (const phase of workflow.phases) {
  if (phase.condition && !phase.condition(ctx)) continue; // branch
  // ...run the phase's sub-agent...
}
```

**Trade-off:** code-routing is cheap, deterministic, and keeps context clean, but
it can only branch on conditions you anticipated. Reach for a workflow when the
*shape* of the work is known ahead of time (research → 3 posts); keep the LLM
orchestrator for open-ended tasks. That's why `run_workflow` is a tool the main
agent *chooses* to call — it delegates only the parts whose steps are known.

## Why it matters: the token tax

Each phase runs in an **isolated in-process sub-agent** — a pi SDK
`createAgentSession` with its own in-memory session and a resource loader that
loads **no extensions** (so a phase can't recursively trigger workflows). The
sub-agent's entire transcript stays inside that session; only its final
structured output crosses back, and it flows phase→phase **in code**, never
re-entering the main session's context window. Spin up ten phases and the main
session pays no per-phase token tax — it stays sharp.

## Quick start

Workflows live in **`.pi/workflows/`**, one workflow per file. Create
`.pi/workflows/hello.js`:

```js
const hello = {
  name: "hello",
  description: "The smallest possible workflow",
  phases: [
    { name: "greet", prompt: "Write a one-sentence friendly greeting.",
      schema: { greeting: "string!" } },
  ],
};

export { hello };
```

Run it from the TUI: `/workflow hello` — or ask the agent: *"run the hello workflow."*
It starts in the **background**; watch with `/workflows`, read output with
`/workflow-result`.

> One file per workflow under `.pi/workflows/` keeps things clean and makes it
> easy for an agent to add a new workflow without touching the others.

### Passing input to a run

A run can be parameterized with free-text **input**, which every phase reads via
`ctx.input`:

```
/workflow scout-and-plan add rate limiting to the public API
```

…or, when the agent starts it, `run_workflow({ name, input })`. Use a function
prompt to fold it in: `prompt: (ctx) => \`Plan this change: ${ctx.input}\``.

## Phase reference

A workflow is `{ name, description?, phases: [...] }`. Each phase:

| Field | Type | Purpose |
| --- | --- | --- |
| `name` | `string` (required) | Phase id; the key its output is stored under |
| `prompt` | `string \| (ctx) => string` | **Model phase:** the prompt for a sub-agent |
| `code` | `(ctx) => any` | **Code phase:** run plain JS instead of a model (no model/tokens); return value is the output |
| `agent` | `string` | (prompt phases) Named agent from `.pi/agents/` (model + tools + persona) |
| `model` | `string` | Override the model for this phase (a pi model pattern, e.g. `claude-haiku-4-5`) |
| `tools` | `string[]` | Restrict tools, e.g. `["read", "bash"]`. Default built-ins: read, bash, edit, write |
| `thinking` | `string` | Thinking level: `off`(default)·`minimal`·`low`·`medium`·`high`·`xhigh` |
| `systemPrompt` | `string` | Extra system-prompt text for this phase |
| `schema` | `object` | Force structured JSON output (validated). Shorthand or longhand — see [Schemas](#schemas) |
| `parallel` | `phase[]` | Fan out into concurrent sub-phases |
| `condition` | `(ctx) => boolean` | Skip the phase entirely when it returns false |
| `loop` | `{ maxIterations, condition, promptTemplate? }` | Repeat the phase |
| `retries` / `retryDelay` | `number` | Auto-retry on failure; ms between tries |
| `timeout` | `number` | Max ms per attempt (default `300000`) |
| `budget` | `{ maxTokens, maxCost, maxTurns }` | **Advisory** limits told to the sub-agent |
| `map` | `(result, ctx) => any` | Reshape output before it is stored |

Phases run top-to-bottom, each isolated. A phase has exactly one of `prompt` (a
model), `code` (deterministic JS), or `parallel`. **Choose deliberately:** use
`prompt` only when the step needs model *judgment*; use `code` for anything
*mechanical* (transform, filter, sort, format, fetch, compute).

### Code phases (`code`)

A `code` phase executes plain JS instead of a model — no model, no tokens,
instant — letting you interleave logic between models (`prompt → code → prompt`).
It gets the same `ctx` and its return value becomes the phase output:

```js
phases: [
  { name: "scan", agent: "scout", prompt: "Find issues.", schema: { issues: "object[]!" } },
  { name: "top3", code: (ctx) => ctx.previous.scan.issues.slice(0, 3) },   // ← code, no model
  { name: "write", agent: "reviewer",
    prompt: (ctx) => `Summarize: ${JSON.stringify(ctx.previous.top3)}` },
]
```

`retries` apply (a thrown error retries); `schema` is optional and, if set,
validates the return value. `model`/`tools`/`thinking`/`budget` don't apply. See
the runnable [`triage`](../../workflows/triage.js) example.

## Passing data between phases

A phase's output is stored under its `name`. Later phases read it via a **function
prompt** (or `code`) receiving `ctx`:

```js
phases: [
  { name: "scout", prompt: "List the key source files.",
    schema: { fields: { files: { type: "array", description: "paths",
      items: { type: "string", description: "path" } } } } },

  { name: "plan",
    prompt: (ctx) => `Plan changes for: ${ctx.previous.scout.files.join(", ")}` },
]
```

`ctx.previous[name]` is the prior phase's output — a **parsed object** if that
phase had a `schema`, otherwise the raw text. `ctx.input` is the free-text input
the run was started with (empty string if none). `ctx.workflow` is the live run
state.

## Schemas

A schema gives the sub-agent a `provide_result` tool whose parameters are the
schema; the model calls it to deliver the result, which pi validates against the
parameter types (a missing required field triggers a retry). This is far more
reliable than asking for a JSON block — if the model answers in prose anyway, the
engine falls back to parsing a JSON block from the text.

### Shorthand

For simple fields, write the type as a string: `"<type>"`, with `[]` for an array
of that type and a trailing `!` to mark it required. A flat map *is* the schema —
no `fields:` wrapper:

```js
schema: {
  summary:  "string!",   // required string
  score:    "number",
  tags:     "string[]",  // array of strings
  files:    "string[]!", // required array of strings
}
```

Types: `string | number | boolean | array | object`. (A shorthand map therefore
can't have a field literally named `fields` — that key signals the longhand form.)

### Longhand

Use the longhand `{ type, description, ... }` form when field **descriptions**
help the model, or for nested `items` / `properties`. You can mix the two — a
longhand field can have shorthand `items`/`properties`:

```js
schema: {
  summary: { type: "string", description: "2-3 sentences", required: true },
  score:   "number",                          // shorthand alongside longhand
  highlights: { type: "array", description: "key points",
    items: { type: "object", description: "one point",
      properties: { title: "string", detail: "string" } } },
}
```

Use `items` for array element shape, `properties` for object shape,
`required: true` (longhand) or a trailing `!` (shorthand) to enforce presence.

## Agents

`agent: "scout"` resolves to a markdown file in `.pi/agents/` (project) or
`~/.pi/agent/agents/` (user):

```markdown
---
name: scout
description: Fast codebase recon
model: claude-haiku-4-5
tools: read, bash
thinking: off
---
You are a code scout. Explore quickly and report concisely.
```

The agent supplies default model / tools / thinking / system prompt; phase-level
`model`, `tools`, `thinking`, `systemPrompt` **override** it. Pin a fast model
here to keep runs snappy — an agent (or phase) with **no** `model` inherits the
main session's current model, which may be a large, pricey one.

---

## Recipes & edge cases

### 1. Conditional gate — skip expensive work when there's nothing to do

`condition` skips a phase outright. Here the review only runs if scouting actually
found issues:

```js
{
  name: "review",
  agent: "reviewer",
  prompt: (ctx) => `Review these issues: ${JSON.stringify(ctx.previous.scout.issues)}`,
  condition: (ctx) => (ctx.previous.scout?.issues?.length ?? 0) > 0,
}
```

A skipped phase produces no output, so **downstream phases must tolerate its
absence** (use `?.` and defaults when reading `ctx.previous.review`).

### 2. Loop until a quality gate passes (iterative refinement)

`loop.condition` is checked *before each iteration after the first* and means
"keep going". It sees the latest iteration's output via `ctx.previous`. Cap it with
`maxIterations` so it always terminates:

```js
{
  name: "draft",
  loop: {
    maxIterations: 4,
    // continue while the last attempt was not yet "good enough"
    condition: (ctx) => ctx.previous.draft?.approved !== true,
    promptTemplate: (i, ctx) =>
      i === 0
        ? "Write a tagline for the product. Self-rate it."
        : `Improve this tagline: "${ctx.previous.draft.text}". ` +
          `Previous critique: ${ctx.previous.draft.critique}. Self-rate again.`,
  },
  schema: { fields: {
    text:     { type: "string",  description: "the tagline", required: true },
    approved: { type: "boolean", description: "true if it meets the bar" },
    critique: { type: "string",  description: "what to fix next time" },
  } },
}
```

Downstream, `ctx.previous.draft` is the **final** iteration's output.

### 3. Fan-out → fan-in (map-reduce)

Run independent analyses in parallel, then a synthesis phase reads all of them.
Parallel results are nested under the parent phase name, keyed by sub-phase name:

```js
phases: [
  {
    name: "checks",
    parallel: [
      { name: "lint",     prompt: "Find lint problems.",        schema: lintSchema },
      { name: "security", prompt: "Audit for vulnerabilities.", schema: secSchema  },
      { name: "tests",    prompt: "Assess test coverage.",      schema: testSchema },
    ],
  },
  {
    name: "synthesis",
    agent: "reviewer",
    prompt: (ctx) => {
      const c = ctx.previous.checks; // { lint, security, tests }
      return "Synthesize one report from:\n" +
        `Lint: ${JSON.stringify(c.lint)}\n` +
        `Security: ${JSON.stringify(c.security)}\n` +
        `Tests: ${JSON.stringify(c.tests)}`;
    },
  },
]
```

Up to 4 sub-phases run at once (max 8 per parallel phase), and a **global cap of 6**
sub-agents applies across *all* running workflows.

### 4. `map` — shrink data before it hits the next prompt

Sub-agent A may return a large object; if the next phase only needs part of it,
`map` reshapes the stored value so the downstream prompt stays small:

```js
{
  name: "discover",
  prompt: "List every data source with full metadata.",
  schema: { fields: { sources: { type: "array", description: "sources",
    items: { type: "object", description: "a source", properties: {
      path: { type: "string", description: "path" },
      size: { type: "number", description: "bytes" },
      meta: { type: "object", description: "lots of extra fields" },
    } } } } },
  // keep only the paths for downstream phases
  map: (result) => result.sources.map((s) => s.path),
}
// later: ctx.previous.discover is now just ["a.csv", "b.json", ...]
```

### 5. Mix models — cheap for recon, strong for synthesis

Per-phase `model` lets you spend tokens where they matter:

```js
phases: [
  { name: "scan",    model: "deepseek-v4-flash:cloud", tools: ["read","grep"],
    prompt: "Quickly map the repo structure.", schema: scanSchema },
  { name: "design",  model: "deepseek-v4-pro:cloud",
    prompt: (ctx) => `Design a refactor given: ${JSON.stringify(ctx.previous.scan)}` },
]
```

### 6. Read-only / sandboxed phases

Restrict `tools` so a phase can't mutate anything (and can't recursively trigger
workflows). A writer that only transforms text needs no tools at all beyond `read`:

```js
{ name: "summarize", tools: ["read"], prompt: (ctx) => `Summarize: ${ctx.previous.scan.summary}` }
```

### 7. Flaky or slow phase — retries + timeout

```js
{
  name: "fetch",
  agent: "researcher",          // uses bash/curl
  prompt: "Fetch and extract the changelog from the project's site.",
  retries: 2,                   // 3 attempts total
  retryDelay: 3000,             // wait 3s between tries
  timeout: 120000,              // fail an attempt after 2 min instead of the 5 min default
}
```

A retry is triggered by any failure: non-zero exit, an error stop reason, a parse
failure, **or a missing required schema field**.

### 8. Optional enrichment with graceful degradation

Combine a `condition` (only enrich when input exists) with defensive reads
downstream, so the workflow still completes if enrichment is skipped:

```js
phases: [
  { name: "extract", prompt: "Extract entities.", schema: { fields: {
      entities: { type: "array", description: "names", items: { type:"string", description:"name" } } } } },

  { name: "enrich",
    condition: (ctx) => ctx.previous.extract.entities.length > 0,
    prompt: (ctx) => `Add context for: ${ctx.previous.extract.entities.join(", ")}`,
    schema: { fields: { enriched: { type: "array", description: "enriched entities",
      items: { type: "string", description: "entity + context" } } } } },

  { name: "report",
    prompt: (ctx) => {
      const enriched = ctx.previous.enrich?.enriched; // may be undefined if skipped
      return enriched
        ? `Write a report using: ${enriched.join("; ")}`
        : `Write a report from raw entities: ${ctx.previous.extract.entities.join(", ")}`;
    } },
]
```

### 9. Budgets (advisory)

Budgets are passed to the sub-agent as instructions — they are **not hard-enforced**
yet. Use them to nudge brevity; don't rely on them as a hard stop:

```js
{ name: "review", agent: "reviewer", prompt: "...", budget: { maxTokens: 50000, maxTurns: 8 } }
```

---

## Gotchas

- **Parallel siblings can't see each other.** A sub-phase only sees *prior completed*
  phases via `ctx.previous`, never its concurrent siblings. Fan in afterward.
- **Parallel output is nested.** It's `ctx.previous.<parent>.<sub>`, not
  `ctx.previous.<sub>`.
- **Loops store only the final iteration** as the phase's downstream output.
- **A `condition` that skips leaves no output** — read skipped phases defensively
  (`ctx.previous.x?.field ?? fallback`).
- **Schema output is tool-driven.** The model calls `provide_result` (params =
  your schema), pi validates the args, and a missing required field triggers a
  retry. A prose-only answer falls back to JSON-block parsing. Keep schemas small
  and field descriptions sharp.
- **Budgets are advisory** (see recipe 9).
- **Runs are persisted to disk**, one JSON file per run, under
  `.pi/workflow-runs/<id>.json` (override the directory with
  `$PI_WORKFLOWS_RUN_DIR`). They survive `/reload`, are addressable by run id,
  and are readable by an external process — see
  [Programmatic / RPC integration](#programmatic--rpc-integration). The
  in-memory registry is just a hot cache over this store.
- **Phases can't recurse into workflows.** Each sub-agent loads no extensions, so
  `run_workflow` isn't available inside a phase. Unrestricted phases still get the
  default mutating built-ins (read, bash, edit, write) — set `tools: ["read"]` for
  a read-only phase.
- **Adding or editing a workflow file is hot** — changes to `.pi/workflows/*.js`
  are picked up on the next `/workflow` or `/workflow-list`, no `/reload` needed.
  (Editing the **extension** source still requires `/reload`.)
- **A broken workflow file is reported, not hidden.** A file that fails to import
  is listed (with its error) by `/workflow-list` instead of silently dropping all
  workflows.
- **Cheap routing is rigid routing.** Code can only branch on conditions you wrote;
  for genuinely unpredictable work, let the main agent orchestrate instead.

## Running workflows

| Command / tool | What it does |
| --- | --- |
| `/workflow-list` | List workflows found in `.pi/workflows/` and any load errors |
| `/workflow <name> [input…]` | Start a workflow in the background (Tab-completes names); trailing text becomes `ctx.input`. Prints the run id |
| `/workflows` | Live progress of all runs (run id, phase status, timings, token usage) |
| `/workflow-result [id\|name]` | Scroll the full output of a finished run (no context cost). With no argument and several finished runs, prompts you to pick one |
| `run_workflow` (tool) | The agent starts a workflow — background by default; takes `name` + optional `input`. Returns the run id + result-file path |
| `get_workflow_result` (tool) | The agent pulls a finished run's output into context on demand; resolve by run id or name |

Workflows run in the **background by default**, so the main agent stays free. On
completion the agent is **not** woken: a passive toast appears and the run's JSON
file is written with its terminal state. That file is the authoritative result;
the agent reports it only when you ask (it calls `get_workflow_result`). A
structured, non-waking marker (`deliverAs: "nextTurn"`) also carries the run id +
file path on the message stream for programmatic consumers. Nothing enters the
main context window until you view it with `/workflow-result` or ask the agent to
fetch it.

## Programmatic / RPC integration

The extension is built to be driven as a component of a larger system — e.g. a
frontend or orchestrator talking to pi over **RPC mode** (`pi --mode rpc`, a
JSONL/stdio JSON-RPC stream). Because an external process cannot see pi's
in-memory state, the **on-disk run store is the integration contract**.

**Where runs live.** One JSON file per run:

```
<project>/.pi/workflow-runs/<runId>.json
```

The directory is resolved from (1) `$PI_WORKFLOWS_RUN_DIR` if set, else (2) the
nearest `.pi/workflow-runs`, else (3) `<cwd>/.pi/workflow-runs`. Files are
written **atomically** (write `*.json.tmp`, then rename), so a reader never sees
a half-written file — safe to `fs.watch` the directory and read any `<id>.json`
on change.

**Run file schema** (`PersistedRun`):

| Field | Meaning |
| --- | --- |
| `schemaVersion` | On-disk format version (currently `1`) |
| `id` | Run id (`wf_…`) — also the filename |
| `name` | Workflow name |
| `status` | `running` · `completed` · `failed` · `cancelled` · `interrupted` |
| `phases` | Per-phase `{ status, output, error, usage, duration, attempts }` — outputs in full |
| `currentPhase` | Phase currently executing (while `running`) |
| `startTime` / `endTime` / `updatedAt` | Epoch ms |
| `error` | Failure / interruption message |
| `input` | The run's free-text input |
| `cwd` / `pid` / `sessionId` | Provenance (launch dir, owning process, session) |
| `usage` | Denormalized token / cost / turn totals |

`interrupted` marks a run whose owning process exited before it finished
(detected and rewritten on the next startup).

**Trigger a run** (no LLM turn): send the `/workflow` command as a `prompt`.

```json
{ "type": "prompt", "message": "/workflow my-flow some input text" }
```

The command handler runs immediately and does **not** start an LLM turn. It
emits a non-waking `workflow-status` custom message whose `details` carry
`{ runId, name, status, file, dir }`, so a client reading the message stream
learns the run id and result path. (Driving via the `run_workflow` *tool*
instead requires the LLM to choose the tool — use the command for deterministic
triggering.)

**Trigger synchronously from the command line** (no RPC lifecycle to manage):

```bash
pi --mode rpc --no-session --run-workflow my-flow --workflow-input "some input text"
```

The `--run-workflow <name>` flag (with optional `--workflow-input "<text>"`) runs
the workflow **to completion**, writes its run file, prints that file's absolute
path as the final stdout line, and exits — `0` completed, `1` failed, `2` unknown
workflow. This is the agent-free, synchronous peer of the `run_workflow` tool,
purpose-built for an orchestrator that spawns pi as a subprocess and reads back a
result file. Launch it in a non-interactive mode (`--mode rpc` or print) so the
process doesn't try to open a TUI; `--no-session` skips writing a session file.

> **The three front doors share one engine + run store:** the `run_workflow`
> **tool** (agent), the `/workflow` **command** (user / RPC `prompt`), and the
> `--run-workflow` **flag** (headless CLI) all call the same executor and write
> the same `.pi/workflow-runs/<id>.json`. `input` / trailing text /
> `--workflow-input` are the same value (phases read it as `ctx.input`), so a run
> is identical downstream no matter who fired it.

**Observe progress.** Watch the run-store directory; each phase transition
rewrites the run file (throttled, with a guaranteed final write on the terminal
state). The `/workflows` and `/workflow-result` commands also emit machine-readable
summaries (a one-line `notify` plus a structured `workflow-status` marker) when
there is no interactive TUI, instead of erroring.

**Fetch the result.** Read `<id>.json` directly for the full, untruncated
output, or have the agent call `get_workflow_result({ name: "<runId>" })`.

**Retention.** On startup the store is pruned to the newest ~50 runs and drops
runs older than ~14 days (running runs with a live owner and very recent runs are
never pruned; the count pruned is reported). Orphaned `*.json.tmp` files are swept.
