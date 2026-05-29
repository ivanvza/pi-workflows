---
name: workflows
description: >-
  Build, edit, and run pi workflows — deterministic, code-routed multi-agent
  pipelines in .pi/workflows/*.js (prompt phases = model judgment, code phases =
  plain JS). Use when asked to create, scaffold, edit, or run a workflow or
  multi-step automation.
---

# Workflows — build & run

A **workflow** moves orchestration from the LLM into code. You write JS that
decides *what runs, when, and in parallel*; the model only supplies *judgment*
inside the phases that need it. Each phase that uses a model runs as an isolated
in-process sub-agent whose transcript never enters the main context window — only
its final structured output flows to the next phase, in code.

Reach for a workflow when the **shape of the work is known ahead of time**. For
open-ended, unpredictable work, let the main agent orchestrate instead.

## The two phase types — choose deliberately

This is the most important decision when authoring. Every phase is **one** of:

| | **`prompt`** phase (model) | **`code`** phase (deterministic JS) |
| --- | --- | --- |
| Runs | a sub-agent (an LLM call) | plain JS in the engine — **no model, no tokens** |
| Use for | **judgment**: writing, reasoning, analysis, extracting from messy/unstructured input | **mechanical** work: transform, filter, sort, count, format, fetch, parse, merge, call an API |
| Output | text, or structured data if you add a `schema` | exactly the value you `return` |
| Reliability | variable (it's a model) | exact and repeatable |

**Default to `code` for anything mechanical.** Rendering data into a table,
picking the top N, reshaping JSON, computing totals, scraping a page — these need
*no* judgment, so a model is the wrong tool: slower, costs tokens, and can be
lazy or hallucinate. Use a `prompt` phase only where genuine judgment is needed.

You can freely interleave them: `prompt → code → prompt` (e.g. brainstorm with a
model → shortlist deterministically in code → polish with a model).

> **Footgun:** a `prompt` phase is meant to *return* its result. If you give it
> no `schema` and don't restrict `tools`, the sub-agent has the default
> read/bash/edit/write tools and may "helpfully" **write a file** and then just
> describe what it did — so the phase output is prose, not your artifact. For a
> phase that should hand back content, add a `schema` (so it returns via the
> result tool) and usually `tools: []`. Better yet, if the step is mechanical,
> make it a `code` phase.

## Where files live

- **One workflow per file** in `.pi/workflows/<name>.js`.
- **Agents** (reusable model + tools + persona) live in `.pi/agents/<name>.md`.
- Each file uses ESM `export`. Adding or editing a workflow file is picked up
  automatically on the next `/workflow` / `/workflow-list` (no `/reload`).

## How to author a workflow (procedure)

1. **Confirm it's workflow-shaped.** Fixed sequence with known branching? Good.
   Open-ended? Suggest the main agent instead.
2. **Name it** in kebab-case; that's the `name` field and the file name.
3. **Break the work into phases, and for EACH phase decide its type first:**
   does this step need model *judgment* (`prompt`) or is it *mechanical* (`code`)?
   When in doubt and the step is a transform/format/compute, choose `code`.
4. **Decide each phase's output.** Need structured data downstream? Add a
   `schema`. A `prompt` phase that returns an artifact almost always wants one.
5. **Choose models/tools/thinking** for `prompt` phases. Pin a fast model +
   `thinking: off` for recon; restrict `tools` (`tools: []` for pure generation,
   `["read"]` for read-only).
6. **Wire data between phases** via function prompts / code reading
   `ctx.previous.<name>` and `ctx.input`.
7. **Add resilience**: `retries`, `timeout`, `condition`, `loop`.
8. **Write any agents** referenced by `agent:` into `.pi/agents/`.
9. **Run** `/workflow <name> [input…]` (a new/edited workflow file is picked up
   automatically — no `/reload` needed).

## The workflow object

```js
// .pi/workflows/example.js
const example = {
  name: "example",
  description: "One line on what it does",
  phases: [ /* run top-to-bottom, each isolated */ ],
};
export { example };
```

### Phase fields

| Field | Type | Purpose |
| --- | --- | --- |
| `name` | `string` (required) | Phase id; the key its output is stored under in `ctx.previous` |
| `prompt` | `string \| (ctx) => string` | **Model phase.** The prompt for a sub-agent. Function form reads prior results / input |
| `code` | `(ctx) => any` | **Code phase.** Run plain JS instead of a model; the return value is the output |
| `agent` | `string` | (prompt phases) Named agent from `.pi/agents/` — default model/tools/thinking/persona |
| `model` | `string` | (prompt phases) Override model, e.g. `claude-haiku-4-5` |
| `tools` | `string[]` | (prompt phases) Restrict tools. Default: read, bash, edit, write. `[]` = none |
| `thinking` | `string` | (prompt phases) `off`(default)·`minimal`·`low`·`medium`·`high`·`xhigh` |
| `systemPrompt` | `string` | (prompt phases) Extra system-prompt text |
| `schema` | `object` | Force/validate structured output (see Schemas). Works for both phase types |
| `parallel` | `phase[]` | Fan out into concurrent sub-phases (max 8; global cap 6 sub-agents) |
| `condition` | `(ctx) => boolean` | Skip the phase entirely when it returns false |
| `loop` | `{ maxIterations, condition, promptTemplate? }` | Repeat the phase (iterative refinement) |
| `map` | `(result, ctx) => any` | Reshape the output before it's stored |
| `retries` / `retryDelay` | `number` | Auto-retry on failure; ms between tries |
| `timeout` | `number` | Max ms per attempt for a prompt phase (default 300000) |
| `budget` | `{ maxTokens, maxCost, maxTurns }` | (prompt phases) **Advisory** limits |

A phase must have exactly one of `prompt`, `code`, or `parallel`.

### Code phases (`code`)

```js
phases: [
  { name: "scan", agent: "scout", prompt: "Find issues.", schema: { issues: "object[]!" } },
  // ── code phase: no model ──
  { name: "top3", code: (ctx) => ctx.previous.scan.issues.slice(0, 3) },
  { name: "write", agent: "reviewer",
    prompt: (ctx) => `Summarize: ${JSON.stringify(ctx.previous.top3)}` },
]
```

`code` can be `async` (fetch, read files, call your own API). `retries` apply (a
thrown error retries); `schema` is optional but, if set, validates the return
value. `model`/`tools`/`thinking`/`agent`/`budget` don't apply to a code phase.

## Schemas

A `schema` gives a phase a `provide_result` contract. For a `prompt` phase the
sub-agent calls that tool and pi validates the args (a missing required field
triggers a retry); for a `code` phase the returned value is validated the same
way. The phase output is the parsed object. Without a schema, a `prompt` phase
returns raw text and a `code` phase returns whatever it returns.

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

## Reading data between phases: `ctx`

`prompt` functions, `code`, `condition`, `loop`, and `map` all receive `ctx`:

- `ctx.previous[name]` — a prior phase's output (parsed object if it had a schema,
  else raw text). For `parallel`, it's nested: `ctx.previous.<parent>.<sub>`.
- `ctx.input` — the free-text input the run was started with (empty if none).
- `ctx.workflow` — the live run state.

## Agents

`agent: "scout"` resolves to `.pi/agents/scout.md`:

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

The agent supplies defaults; phase-level `model`/`tools`/`thinking`/`systemPrompt`
override them. An unpinned `prompt` phase inherits the main session's model
(possibly expensive) — pin a fast one to keep runs cheap.

## Control flow at a glance

- **Parallel:** a phase with `parallel: [...]` runs sub-phases concurrently (each
  a `prompt` or `code` sub-phase); each sees only *prior completed* phases, never
  its siblings. Fan in with a later phase reading `ctx.previous.<parent>.<sub>`.
- **Conditional gate:** `condition: (ctx) => …` skips the phase; read skipped
  phases defensively downstream (`ctx.previous.x?.field ?? fallback`).
- **Loop:** `loop: { maxIterations, condition, promptTemplate }` repeats a prompt
  phase for refinement; `condition` is "keep going", checked before each
  iteration after the first; only the final iteration is stored.
- **map:** trim a large result before it reaches the next phase.

Copy-paste patterns: [references/recipes.md](references/recipes.md).

## Validate & run

- A file that fails to import is reported (with its error) by `/workflow-list`
  instead of silently dropping all workflows. After writing a file, have the user
  run `/workflow-list` to confirm it loaded (no `/reload` needed for workflow files).
- **Run:** `/workflow <name> [input…]` (background) — trailing text becomes
  `ctx.input`. Or the agent calls `run_workflow({ name, input })`. Each run gets
  an id (`wf_…`) and is persisted to `.pi/workflow-runs/<id>.json`.
- **Watch:** `/workflows`. **Read full output:** `/workflow-result` (no arg →
  pick from recent runs; or pass a run id / name) or `get_workflow_result({ name })`.
- **Completion does not wake the agent.** A passive toast fires and the run file
  is written; report results only when the user asks (then call get_workflow_result).

## Gotchas

- **Mechanical step? Use `code`, not `prompt`.** Tables, sorting, reshaping, and
  scraping are deterministic — a model only adds cost, latency, and variance.
- **A `prompt` phase that should return content needs a `schema`** (and usually
  `tools: []`) — otherwise it may write a file and report prose (see the footgun).
- **Workflow file edits are hot** (picked up on the next run); only **extension**
  source edits need `/reload`.
- **Parallel output is nested** under the parent name; siblings can't see each other.
- **Loops store only the final iteration.**
- **Phases can't recurse into workflows** (sub-agents load no extensions).
- **Budgets are advisory.** **Runs persist** to `.pi/workflow-runs/<id>.json`
  (override the dir with `$PI_WORKFLOWS_RUN_DIR`) and survive `/reload`; an
  external process can list/watch/read them — see the README's RPC section.

A complete annotated reference also ships at
`.pi/extensions/workflows/README.md`.
