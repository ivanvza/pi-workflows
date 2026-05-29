---
name: workflows
description: >-
  Build, edit, and run pi workflows — code-routed multi-agent pipelines in
  .pi/workflows/*.js. Plain JS handles control flow (loops, conditionals,
  fan-out); each agent() call is an isolated sub-agent supplying judgment. Use
  when asked to create, scaffold, edit, or run a workflow or multi-step automation.
---

# Workflows — build & run

A **workflow** moves orchestration from the LLM into code. You write a plain
async JS function that decides *what runs, when, and in parallel* — using native
`if`/`for`/`.map`/`.filter` plus the `parallel`/`pipeline` primitives. The model
only supplies *judgment*, inside each `agent()` call. Every `agent()` runs as an
isolated in-process sub-agent whose transcript never enters the main context
window — only its final text or structured output flows back into your function,
as an ordinary return value.

**The core idea: CODE handles control flow, the MODEL handles judgment.** Loops,
branches, transforms, fan-out, fan-in — all native JS. Reach for `agent()` only
where a step genuinely needs reasoning, writing, or analysis.

Reach for a workflow when the **shape of the work is known ahead of time**. For
open-ended, unpredictable work, let the main agent orchestrate instead.

## The file shape

A workflow is an ES module exporting `meta` and a default async function:

```js
// .pi/workflows/example.js
export const meta = {
  name: "example",              // REQUIRED — the /workflow <name> key + discovery key
  description: "One line on what it does",
  phases: ["analyze", "checks⇉", "report"], // OPTIONAL display-only flow hint;
                                            //   "name⇉" marks a parallel group. Ignored by the engine.
};

export default async function ({ agent, parallel, pipeline, phase, log, args, cwd, budget }) {
  // ... plain JS orchestration ...
  return deliverable;           // the function's return value IS the run's result
}
```

The single argument is the **injected runtime**; destructure only what you use.

## The runtime primitives

| Primitive | Signature | What it does |
| --- | --- | --- |
| `agent` | `(prompt, opts?) => Promise<string \| object>` | Run ONE isolated sub-agent. Returns its final text, or — with `opts.schema` — the validated object. Throws after retries, so native `try/catch` works. |
| `parallel` | `(thunks: Array<() => Promise<T>>) => Promise<Array<T\|null>>` | Run thunks concurrently (BARRIER — awaits all). Results in INPUT order. A thunk that throws yields `null` in its slot (one bad task never aborts the batch). Filter with `.filter(Boolean)`. |
| `pipeline` | `(items, ...stages) => Promise<any[]>` | Each item flows through ALL stages independently (stage k gets stage k-1's output for that item), NO barrier between items. Each stage is `(item, index) => result`. A failed chain yields `null`. |
| `phase` | `(title) => void` | Open a progress group in `/workflows`; later `agent()` steps show under it. No tokens. |
| `log` | `(msg) => void` | A narrator line in `/workflows`. No tokens. |
| `args` | `string` | The run's free-text input (from `/workflow <name> <args…>` or `run_workflow`). `""` if none. |
| `cwd` | `string` | Working directory the run launched from. |
| `budget` | `{ maxTokens?, maxCost?, maxTurns? }?` | Run-level default budget (per-call `opts.budget` wins). Currently always `undefined`. |

## CODE vs MODEL — choose deliberately

This is the most important decision when authoring. For every step, ask: does it
need model *judgment*, or is it *mechanical*?

| | **`agent()` call** (model) | **plain JS** (deterministic) |
| --- | --- | --- |
| Runs | an isolated sub-agent (an LLM call) | code in the function body — **no model, no tokens** |
| Use for | **judgment**: writing, reasoning, analysis, extracting from messy/unstructured input | **mechanical** work: transform, filter, sort, count, format, fetch, parse, merge, call an API |
| Output | text, or a validated object with `schema` | exactly the value you compute |
| Reliability | variable (it's a model) | exact and repeatable |

**Default to plain JS for anything mechanical.** Rendering data into a table,
picking the top N, reshaping JSON, computing totals, scraping a page — these need
*no* judgment, so a model is the wrong tool: slower, costs tokens, can be lazy or
hallucinate. Just write the JS:

```js
const RANK = { high: 0, medium: 1, low: 2 };
const vulns = (security?.vulnerabilities ?? [])
  .slice()
  .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));
```

Interleave freely: `agent()` to brainstorm → JS to shortlist → `agent()` to
polish.

> **Footgun:** an `agent()` call is meant to *return* its result. If you give it
> no `schema` and don't restrict `tools`, the sub-agent has the default
> read/bash/edit/write tools and may "helpfully" **write a file** and then just
> describe what it did — so you get prose back, not your artifact. For a step
> that should hand back content, set a `schema` (it returns via the
> `provide_result` tool) and usually `tools: []`. Better yet, if the step is
> mechanical, don't use `agent()` at all — write the JS.

## `agent()` options

All optional:

| Option | Type | Purpose |
| --- | --- | --- |
| `agent` | `string` | Named persona from `.pi/agents/*.md` — supplies default model/tools/thinking/systemPrompt |
| `model` | `string` | Model pattern, e.g. `"claude-haiku-4-5"`; overrides the persona; falls back to the session model |
| `tools` | `string[]` | Tool allowlist. Default `["read","bash","edit","write"]`; `[]` = pure reasoning / return-only |
| `thinking` | `string` | `"off"`(default)·`"minimal"`·`"low"`·`"medium"`·`"high"`·`"xhigh"` |
| `systemPrompt` | `string` | Extra system-prompt text, appended after the persona's |
| `schema` | `SchemaInput` | Force structured output via `provide_result` (see Schemas) |
| `retries` | `number` | Default `0`. A schema mismatch counts as a retryable failure |
| `retryDelay` | `number` | Ms between retries, default `2000` |
| `timeout` | `number` | Ms per attempt, default `300000` |
| `budget` | `{ maxTokens?, maxCost?, maxTurns? }` | Advisory; merged over the run-level budget |
| `label` | `string` | Display name for this step in `/workflows` (unlabeled steps auto-number within the phase group) |

An **unpinned** `agent()` inherits the main session's model (possibly expensive)
— pin a fast `model` (or use a persona that does) on recon steps to keep runs cheap.

## Data flows through plain variables

There is no `ctx.previous` and no `ctx.input`. A prior step's output is just the
value you assigned it; the run input is `args`:

```js
const analysis = await agent("Analyze the codebase…", {
  agent: "scout",
  schema: { files: "string[]!", architecture: "string" },
  retries: 2,
  label: "analyze",
});
log(`Analyzed ${analysis.files.length} files`);

// pass it forward — it's just a variable
const review = await agent(
  "Synthesize a review from " + JSON.stringify({ analysis, args }),
  { agent: "reviewer", schema: { summary: "string!" }, label: "review" },
);
```

## Control flow is native JS

| Need | How |
| --- | --- |
| Conditional / gate | `if (analysis.files.length === 0) return "nothing to review";` |
| Loop / iterative refinement | `for (let i = 0; i < 3 && !done; i++) { … }` — per-attempt reliability is `opts.retries` |
| Transform / reshape / pick top N | `const top = result.items.sort(…).slice(0, 3)` |
| Fan-out (barrier) | `const [a, b] = await parallel([() => agent(…), () => agent(…)])` |
| Per-item multi-stage | `const out = await pipeline(items, (it) => agent(…), (mid) => agent(…))` |
| Fan-in | read the parallel/pipeline results as ordinary arrays |
| Error handling | `try { await agent(…) } catch (e) { … }` — `agent()` throws after retries |

`parallel` returns results in input order with `null` for any thrown thunk;
`.filter(Boolean)` to drop failures. Concurrency is capped internally and by the
global sub-agent semaphore, so arbitrary-length arrays are fine.

## Schemas (`opts.schema`)

A `schema` gives an `agent()` call a `provide_result` contract: the sub-agent
calls that tool, pi validates the args (a missing required field triggers a
retry), and `agent()` resolves to the parsed object. Without a schema, `agent()`
returns raw text.

**Shorthand** — write the type as a string. `[]` = array of, trailing `!` =
required. A flat map *is* the schema (no `fields:` wrapper):

```js
schema: { summary: "string!", score: "number", tags: "string[]", files: "string[]!" }
```

Types: `string | number | boolean | array | object`.

**Longhand** — use when field **descriptions** help the model, or for nested
`items` / `properties`. You can mix the two:

```js
schema: {
  summary: { type: "string", description: "2-3 sentences", required: true },
  score:   "number",
  steps: { type: "array", description: "ordered steps",
    items: { type: "object", description: "a step",
      properties: { order: "number", action: "string", file: "string" } } },
}
```

Access the result as plain JS: `const { summary, score } = await agent(…)`.

## Personas (`.pi/agents/*.md`)

`{ agent: "scout" }` resolves to `.pi/agents/scout.md`:

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

The persona supplies defaults; per-call `model`/`tools`/`thinking`/`systemPrompt`
override them. Available personas: **planner, researcher, reviewer, scout,
social-writer, sysadmin**.

## How to author a workflow (procedure)

1. **Confirm it's workflow-shaped.** Fixed sequence with known branching? Good.
   Open-ended? Suggest the main agent instead.
2. **Name it** in kebab-case; that's `meta.name` and the file name.
3. **Sketch the control flow in JS first** — the loops, branches, and fan-out.
   This is the skeleton; `agent()` calls only fill the judgment slots.
4. **For each step decide: model or JS?** If it's a transform/format/compute/
   fetch, write plain JS. Only use `agent()` where judgment is required.
5. **Give every returning `agent()` a `schema`** (and usually `tools: []`) so it
   hands back data, not prose.
6. **Pin models/tools/thinking** on `agent()` calls — fast model + `thinking: off`
   for recon; `tools: []` for pure generation, `["read"]` for read-only.
7. **Add resilience** with `retries`/`timeout` and native `try/catch`.
8. **Add `phase()` / `log()`** for live progress in `/workflows`.
9. **Write any personas** referenced by `agent:` into `.pi/agents/`.
10. **Run** `/workflow <name> [input…]` — a new/edited workflow file is picked up
    automatically (no `/reload` needed).

Copy-paste patterns: [references/recipes.md](references/recipes.md).

## Where files live

- **One workflow per file** in `.pi/workflows/<name>.js` (ESM `export`).
- **Personas** live in `.pi/agents/<name>.md`.
- Adding or editing a workflow file is picked up automatically on the next
  `/workflow` / `/workflow-list` (no `/reload`). Only **extension** source edits
  need `/reload`.

## Validate & run

- `/workflow-list` reports any file that fails to import **or that imports but
  exports no workflow** (e.g. a file still in the retired declarative
  `phases: [...]` format) — with a per-file reason — instead of silently dropping
  it. After writing a file, have the user run `/workflow-list` to confirm it loaded.
- **Run:** `/workflow <name> [input…]` (background) — trailing text becomes
  `args`. Add `--wait` to block instead: in the TUI it opens a live progress view
  (then a scrollable result, Esc to cancel/close), costing **no** main-context
  tokens; over RPC it runs synchronously and emits a terminal marker. Or the agent
  calls `run_workflow({ name, input })` (add `wait: true` to block — but that pulls
  the result into the agent's context). Each run gets an id (`wf_…`) and is
  persisted to `.pi/workflow-runs/<id>.json`.
- **Watch:** `/workflows`. **Read full output:** `/workflow-result` (no arg →
  pick from recent runs; or pass a run id / name) or `get_workflow_result({ name })`.
- **Completion does not wake the agent.** A passive toast fires and the run file
  is written; report results only when the user asks (then call get_workflow_result).

## Gotchas

- **Mechanical step? Write JS, not `agent()`.** Tables, sorting, reshaping, and
  scraping are deterministic — a model only adds cost, latency, and variance.
- **A returning `agent()` needs a `schema`** (and usually `tools: []`) — otherwise
  it may write a file and report prose (the footgun).
- **`parallel` is a barrier** (awaits all); `pipeline` has no barrier between
  items. Both return results in input order, with `null` for thrown work.
- **Sub-agents load no extensions**, so a workflow can't recurse into another
  workflow from inside an `agent()` call.
- **Budgets are advisory.** **Runs persist** to `.pi/workflow-runs/<id>.json`
  (override the dir with `$PI_WORKFLOWS_RUN_DIR`) and survive `/reload`; an
  external process can list/watch/read them — see the README's RPC section.

A complete annotated reference also ships at
`.pi/extensions/workflows/README.md`.
