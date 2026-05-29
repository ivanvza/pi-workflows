# Workflows

Code-driven multi-agent orchestration for pi. You write a workflow as a plain
async function in `.pi/workflows/*.js`; **code handles the control flow, the model
only handles judgment inside each step.**

```
use code for what code is good at  → control flow (what runs, when, in parallel)
use models for what models are good at → judgment (the actual work of each step)
```

---

## Table of contents

- [The idea](#the-idea)
- [Why it matters: the token tax](#why-it-matters-the-token-tax)
- [Quick start](#quick-start)
- [File format](#file-format)
- [The runtime](#the-runtime)
- [`agent()` options](#agent-options)
- [Control flow at a glance](#control-flow-at-a-glance)
- [`parallel` and `pipeline`](#parallel-and-pipeline)
- [Schemas](#schemas)
- [Agent personas](#agent-personas)
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

"Plan the next step" is the routing decision the orchestrator makes *every turn*.
In the old pattern the model makes it — re-reading the whole growing context each
time, non-deterministically. Workflows **move routing into code**: your function
body *is* the plan, and ordinary `if` / `for` / `await` *are* the branches. The
model is invoked *inside* a step (`agent(...)`), never *between* steps to choose
the route.

```js
// This loop IS the "plan". No model call decides what's next.
for (const file of files) {
  if (!shouldReview(file)) continue;              // branch — plain JS
  await agent(`Review ${file}`, { agent: "reviewer" });
}
```

**Trade-off:** code-routing is cheap, deterministic, and keeps context clean, but
it can only branch on conditions you anticipated. Reach for a workflow when the
*shape* of the work is known ahead of time (research → 3 posts); keep the LLM
orchestrator for open-ended tasks. That's why `run_workflow` is a tool the main
agent *chooses* to call — it delegates only the parts whose steps are known.

## Why it matters: the token tax

Each `agent()` call runs in an **isolated in-process sub-agent** — a pi SDK
`createAgentSession` with its own in-memory session and a resource loader that
loads **no extensions** (so a step can't recursively trigger workflows), no
skills, no themes, no context files. The sub-agent's entire transcript stays
inside that session; only its final result (text, or — with a schema — a
validated object) crosses back, and it flows step→step **in ordinary JS
variables**, never re-entering the main session's context window. Spin up ten
sub-agents and the main session pays no per-step token tax — it stays sharp.

## Quick start

Workflows live in **`.pi/workflows/`**, one workflow per file. Create
`.pi/workflows/hello.js`:

```js
export const meta = {
  name: "hello",
  description: "The smallest possible workflow",
};

export default async function ({ agent, args }) {
  const { greeting } = await agent(
    args
      ? `Write a one-sentence friendly greeting for: ${args}`
      : "Write a one-sentence friendly greeting.",
    { schema: { greeting: "string!" }, tools: [], label: "greet" },
  );
  return greeting;
}
```

Run it from the TUI: `/workflow hello` — or ask the agent: *"run the hello
workflow."* It starts in the **background**; watch with `/workflows`, read output
with `/workflow-result`.

> One file per workflow under `.pi/workflows/` keeps things clean and makes it
> easy for an agent to add a new workflow without touching the others.

### Passing input to a run

A run can be parameterized with free-text **input**, exposed to the function as
`args`:

```
/workflow scout-and-plan add rate limiting to the public API
```

…or, when the agent starts it, `run_workflow({ name, input })`. Fold it into a
prompt: `` `Plan this change: ${args}` `` (`args` is `""` when none was given).

## File format

A workflow file is an **ES module** with two exports:

```js
export const meta = {
  name: "code-review",                       // REQUIRED — the /workflow <name> + discovery key
  description: "Comprehensive code review",  // shown in /workflow-list and list_workflows
  phases: ["analyze", "checks⇉", "review", "report"], // OPTIONAL display-only flow hint
};

export default async function (rt) {
  // ...orchestration using rt.agent / rt.parallel / rt.phase / ...
  return deliverable;                        // the return value IS the run's result
}
```

- **`meta.name`** is required — it's both the `/workflow <name>` key and the
  discovery key. If omitted, the filename (sans extension) is the last-resort name.
- **`meta.description`** appears in `/workflow-list` and `list_workflows`.
- **`meta.phases`** is a *display-only* static hint for the listing. A `"name⇉"`
  suffix marks a parallel group. It is **ignored by the engine** — live progress
  is built from your `phase()` / `agent()` calls. Omit it and the listing shows
  "dynamic".
- The **default export** is an `async function` taking the single runtime
  argument (below). Its **return value is the deliverable** — the run's result.
  If the body returns nothing, the engine falls back to the last completed step's
  output so trivial bodies still surface something.
- `meta` may live on the module or on the default export. A file with no
  default-export function contributes no workflow — and is reported as a load
  error (with a hint if it's still in the retired declarative format), not
  silently dropped.
- Both `*.js` and `*.ts` are discovered (pi loads TS via its jiti loader).

## The runtime

The function receives **one argument** — the runtime — which you destructure:

```js
export default async function ({ agent, parallel, pipeline, phase, log, args, cwd, budget }) { ... }
```

| Member | Signature | What it does |
| --- | --- | --- |
| `agent` | `(prompt, opts?) => Promise<string \| object>` | Run **one** isolated sub-agent. Returns its final text, or — when `opts.schema` is set — the validated object. **Throws** after exhausting retries, so native `try/catch` works. See [options](#agent-options). |
| `parallel` | `(thunks) => Promise<Array<T \| null>>` | Run thunks concurrently behind a **barrier** (awaits all). Results in **input order**; a thunk that throws yields `null` in its slot. See [below](#parallel-and-pipeline). |
| `pipeline` | `(items, ...stages) => Promise<any[]>` | Each item flows through **all** stages independently — **no barrier** between items. Results in input order; an item whose chain throws yields `null`. See [below](#parallel-and-pipeline). |
| `phase` | `(title) => void` | Open a named progress group; subsequent `agent()` steps display under it in `/workflows`. Pure UX — **no model, no tokens**. |
| `log` | `(msg) => void` | Emit a narrator line shown in `/workflows`. **No model, no tokens.** Ephemeral (not persisted). |
| `args` | `string` | The run's free-text input (`/workflow <name> <args…>` or `run_workflow`'s `input`). `""` if none. |
| `cwd` | `string` | Working directory the run launched from. |
| `budget` | `{ maxTokens?, maxCost?, maxTurns? } \| undefined` | Run-level default budget (per-call `opts.budget` wins). Currently always `undefined` — reserved. |

Everything else — loops, conditionals, transforms, filtering, sorting, fetching —
is **plain JS in your function body**. There is no separate phase object, no
`ctx.previous`: a sub-agent's output is just the value `agent()` returns, held in
an ordinary variable.

## `agent()` options

`agent(prompt, opts)` — every `opts` field is **optional**:

| Field | Type | Default | Purpose |
| --- | --- | --- | --- |
| `agent` | `string` | — | Named **persona** from `.pi/agents/*.md` — supplies default model / tools / thinking / system prompt. The options below **override** it. |
| `model` | `string` | session model | Model pattern (e.g. `claude-haiku-4-5`). Overrides the persona; falls back to the main session's current model. |
| `tools` | `string[]` | `["read","bash","edit","write"]` | Tool allowlist for this sub-agent. `[]` = pure reasoning / return-only (no tools). |
| `thinking` | `string` | `"off"` | `off`·`minimal`·`low`·`medium`·`high`·`xhigh`. |
| `systemPrompt` | `string` | — | Extra system-prompt text, appended **after** the persona's. |
| `schema` | `SchemaInput` | — | Force structured output via the `provide_result` tool; `agent()` returns the validated object. See [Schemas](#schemas). |
| `retries` | `number` | `0` | Auto-retries on failure (so `2` = 3 attempts total). A **schema mismatch counts as a retryable failure**, so retries also re-roll bad structured output. |
| `retryDelay` | `number` | `2000` | Milliseconds between retries. |
| `timeout` | `number` | `300000` | Max milliseconds **per attempt**. |
| `budget` | `{ maxTokens?, maxCost?, maxTurns? }` | — | **Advisory** — surfaced to the sub-agent as guidance, merged over the run-level budget (this wins). Not hard-enforced. |
| `label` | `string` | auto | Display name for this step in `/workflows`. Unlabeled steps auto-number within their `phase()` group (`<group>/agent-N`). |

Precedence is `opts.* > persona > main-session default`. An `agent()` call with
**no** `model` (and no persona model) inherits the main session's current model,
which may be a large, pricey one — pin a fast model on recon steps.

```js
const analysis = await agent("Map the repo structure.", {
  agent: "scout",                          // persona supplies a fast model + read-only tools
  schema: { files: "string[]!", architecture: "string" },
  retries: 2,
  label: "analyze",
});
log(`Analyzed ${analysis.files.length} files`);  // ordinary JS on the returned object
```

## Control flow at a glance

There are **no** control-flow fields — you write native JS. The old declarative
constructs map directly onto language features:

| You want… | Old declarative field | Now — native JS |
| --- | --- | --- |
| Deterministic transform/filter/sort/fetch | a `code` phase | just write it in the function body — a `.map`/`.filter`/`.sort`/`fetch`/compute. **No model, no tokens.** |
| Skip a step conditionally | `condition` | `if (...) { await agent(...) }` |
| Repeat until a quality gate passes | `loop` / `LoopConfig` | a `for`/`while` loop with `break`; per-attempt reliability is `opts.retries` |
| Reshape an output before reuse | `map` | transform the returned value in JS (`const ranked = result.items.sort(...)`) |
| Fan out / stream | the `parallel` phase field | the `parallel()` / `pipeline()` primitives |
| Read a prior step's output | `ctx.previous.<name>` | an ordinary local variable (`const a = await agent(...)`) |
| The run's input | `ctx.input` | `args` |
| Name a step | `phase.name` | a JS variable binding; `opts.label` is just the display name |

```js
// Conditional gate — only review when scouting found something.
const scan = await agent("Find issues.", { agent: "scout", schema: { issues: "object[]!" } });
if (scan.issues.length > 0) {
  await agent(`Review: ${JSON.stringify(scan.issues)}`, { agent: "reviewer" });
}

// Loop until good enough — native while + retries for per-attempt reliability.
let draft = await agent("Write a tagline. Self-rate it.",
  { schema: { text: "string!", approved: "boolean" }, retries: 1 });
let i = 0;
while (!draft.approved && i++ < 3) {
  draft = await agent(`Improve: "${draft.text}". Self-rate again.`,
    { schema: { text: "string!", approved: "boolean" } });
}

// Deterministic transform — plain JS, no model, no tokens.
const RANK = { high: 0, medium: 1, low: 2 };
const top = scan.issues.slice().sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9)).slice(0, 3);
```

## `parallel` and `pipeline`

Both run sub-agents concurrently, capped internally at `MAX_CONCURRENCY = 4`
items in flight and bounded further by the [global semaphore](#concurrency).
**Both are forgiving:** a failing task yields `null` in its slot rather than
aborting the whole batch, so one bad task never sinks the others.

### `parallel(thunks)` — fan-out → fan-in (barrier)

Pass an array of **thunks** (`() => Promise<T>`). It awaits **all** of them and
returns results in **input order**; a thunk that throws yields `null` (the
failure is still visible as that agent's failed step). Filter with
`.filter(Boolean)`. Arbitrary-length arrays are fine — they queue.

```js
phase("Checks");
const [lint, security, tests] = await parallel([
  () => agent("Scan for lint issues.",     { label: "lint",     schema: lintSchema }),
  () => agent("Audit for vulnerabilities.", { label: "security", schema: secSchema  }),
  () => agent("Assess test coverage.",      { label: "tests",    schema: testSchema }),
]);
// Siblings can't see each other; fan in afterward in plain JS:
const report = await agent("Synthesize:\n" + JSON.stringify({ lint, security, tests }),
  { agent: "reviewer", schema: { markdown: "string!" } });
```

### `pipeline(items, ...stages)` — per-item staged stream (no barrier)

Each item flows through **all** stages independently — stage *k* gets stage
*k-1*'s output **for that item** — with **no barrier between items**, so one item
can be in stage 3 while another is still in stage 1. Each stage is
`(item, index) => result`. Results come back in input order; an item whose chain
throws yields `null` (others continue).

```js
const drafts = await pipeline(
  topics,
  (topic)    => agent(`Research: ${topic}`,            { agent: "researcher", schema: { notes: "string!" } }),
  (research) => agent(`Draft a post from: ${research.notes}`, { schema: { post: "string!" } }),
);
return drafts.filter(Boolean).map((d) => d.post);
```

## Schemas

When `opts.schema` is set, the engine gives the sub-agent a `provide_result` tool
whose parameters **are** the schema; the model calls it to deliver the result,
which pi validates against the parameter types (a missing required field triggers
a retry). This is far more reliable than asking for a JSON block — if the model
answers in prose anyway, the engine falls back to parsing a JSON block from the
text. `agent()` returns the validated object; read its fields as plain JS.

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
longhand field can have shorthand `items` / `properties`:

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
The explicit `{ fields: {...} }` wrapper is also accepted.

## Agent personas

`{ agent: "scout" }` resolves to a markdown file in `.pi/agents/` (project) or
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

The persona supplies default model / tools / thinking / system prompt; per-call
`model`, `tools`, `thinking`, `systemPrompt` **override** it. Pin a fast model in
the persona to keep recon snappy. Shipped personas: `planner`, `researcher`,
`reviewer`, `scout`, `social-writer`, `sysadmin`.

## Gotchas

- **A step that should RETURN an artifact needs a `schema`** (and usually
  `tools: []`). Without one, a sub-agent meant to produce a report may write a
  file and answer in prose instead of returning the artifact. Default to plain JS
  for anything mechanical; reach for `agent()` only when the step needs judgment.
- **Parallel siblings can't see each other.** A thunk in a `parallel()` batch
  only sees values you closed over before the batch, never its concurrent
  siblings. Fan in afterward.
- **`parallel`/`pipeline` swallow per-task failures into `null`.** That's
  deliberate (one bad task never aborts the batch) — but you must `.filter(Boolean)`
  or otherwise tolerate the holes downstream. A lone `agent()` call instead
  **throws**, so wrap it in `try/catch` if you don't want a failure to fail the run.
- **Schema output is tool-driven.** The model calls `provide_result` (params =
  your schema), pi validates the args, and a missing required field triggers a
  retry. A prose-only answer falls back to JSON-block parsing. Keep schemas small
  and field descriptions sharp.
- **Budgets are advisory** — surfaced to the sub-agent as guidance, not
  hard-enforced. Don't rely on them as a hard stop.
- **Runs are persisted to disk**, one JSON file per run, under
  `.pi/workflow-runs/<id>.json` (override the directory with
  `$PI_WORKFLOWS_RUN_DIR`). They survive `/reload`, are addressable by run id,
  and are readable by an external process — see
  [Programmatic / RPC integration](#programmatic--rpc-integration). The
  in-memory registry is just a hot cache over this store.
- **Steps can't recurse into workflows.** Each sub-agent loads no extensions, so
  `run_workflow` isn't available inside an `agent()` call. Unrestricted steps
  still get the default mutating built-ins (`read, bash, edit, write`) — set
  `tools: ["read"]` (or `[]`) for a read-only / pure-reasoning step.
- **Adding or editing a workflow file is hot** — changes to `.pi/workflows/*.js`
  are picked up on the next `/workflow` or `/workflow-list`, no `/reload` needed.
  (Editing the **extension** source still requires `/reload`.)
- **A broken or wrong-format workflow file is reported, not hidden.** A file that
  fails to import — *or* imports cleanly but exports no workflow (e.g. one still in
  the retired declarative `phases: [...]` format) — is listed with a per-file
  reason by `/workflow-list`, instead of silently dropping it.
- **Cheap routing is rigid routing.** Code can only branch on conditions you
  wrote; for genuinely unpredictable work, let the main agent orchestrate instead.

### Concurrency

A single `parallel()` / `pipeline()` call dispatches at most
`MAX_CONCURRENCY = 4` sub-agents at once. Above that, a global semaphore caps
**total concurrent sub-agents at `GLOBAL_MAX_AGENTS = 6` across *all* running
workflows** — so several workflows running at once can't spawn an unbounded
number of sessions. Excess tasks queue and start as slots free up.

## Running workflows

| Command / tool | What it does |
| --- | --- |
| `/workflow-list` | List workflows found in `.pi/workflows/` and any load errors |
| `/workflow <name> [input…] [--wait]` | Start a workflow (Tab-completes names); trailing text becomes `args`. Background by default (prints the run id); `--wait` blocks — in the TUI a live progress view then a scrollable result (Esc cancels/closes), over RPC a synchronous run + terminal marker |
| `/workflows` | Live progress of all runs (run id, step status, timings, token usage) |
| `/workflow-result [id\|name]` | Scroll the full output of a finished run (no context cost). With no argument and several finished runs, prompts you to pick one |
| `run_workflow` (tool) | The agent starts a workflow — **background by default** (`wait:true` to block); takes `name` + optional `input`. Background returns the run id + result-file path; `wait:true` returns the full result |
| `list_workflows` (tool) | The agent lists discovered workflows (names + descriptions) |
| `get_workflow_result` (tool) | The agent pulls a finished run's output into context on demand; resolve by run id or name |

Workflows run in the **background by default**, so the main agent stays free. On
completion the agent is **not** woken: a passive toast appears and the run's JSON
file is written with its terminal state. That file is the authoritative result;
the agent reports it only when you ask (it calls `get_workflow_result`). A
structured, **non-waking** marker (a `workflow-status` custom message,
`deliverAs: "nextTurn"`) also carries the run id + file path on the message
stream for programmatic consumers. Nothing enters the main context window until
you view it with `/workflow-result` or ask the agent to fetch it.

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
nearest `.pi/workflow-runs` (sibling of `.pi/workflows`), else (3)
`<cwd>/.pi/workflow-runs`. Files are written **atomically** (write `*.json.tmp`,
then rename), so a reader never sees a half-written file — safe to `fs.watch` the
directory and read any `<id>.json` on change.

**Run file schema** (`PersistedRun`):

| Field | Meaning |
| --- | --- |
| `schemaVersion` | On-disk format version (currently `2`) |
| `id` | Run id (`wf_…`) — also the filename |
| `name` | Workflow name |
| `status` | `running` · `completed` · `failed` · `cancelled` · `interrupted` |
| `phases` | Per-step `{ phaseName, status, output, error, usage, duration, attempts }` — one entry per `agent()` call, outputs in full |
| `currentPhase` | The current `phase()` group (while `running`) |
| `result` | The run's deliverable — the workflow function's return value |
| `startTime` / `endTime` / `updatedAt` | Epoch ms |
| `error` | Failure / interruption message |
| `input` | The run's free-text input (read by the function as `args`) |
| `cwd` / `pid` / `sessionId` | Provenance (launch dir, owning process, session) |
| `usage` | Denormalized token / cost / turn totals |

`interrupted` marks a run whose owning process exited before it finished
(detected and rewritten on the next startup; it maps back to `failed` in the live
registry). The full deliverable is `result`; for older runs persisted before
`result` existed, fall back to the last completed step's `output`.

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
> `--workflow-input` are the same value (the function reads it as `args`), so a
> run is identical downstream no matter who fired it.

**Observe progress.** Watch the run-store directory; each step transition
rewrites the run file (throttled, with a guaranteed final write on the terminal
state). The `/workflows` and `/workflow-result` commands also emit
machine-readable summaries (a one-line `notify` plus a structured
`workflow-status` marker) when there is no interactive TUI, instead of erroring.

**Fetch the result.** Read `<id>.json` directly for the full, untruncated
deliverable, or have the agent call `get_workflow_result({ name: "<runId>" })`.

**Retention.** On startup the store is pruned to the newest ~50 runs and drops
runs older than ~14 days (running runs with a live owner and very recent runs are
never pruned; the count pruned is reported). Orphaned `*.json.tmp` files are swept.
