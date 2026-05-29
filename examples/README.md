# Example Workflows

Copy any of these into your project's `.pi/workflows/` to run them.

Each workflow is an ES module that exports a `meta` object and a default
`async function`. The function body is plain JS orchestration: `code` is just
code, control flow is just `if`/`for`, and data flows step→step through
ordinary local variables. The model is reached only through the injected
`agent()` helper.

```js
export const meta = { name: "hello", description: "..." };

export default async function ({ agent, parallel, phase, log, args }) {
  // plain JS orchestration; the return value IS the run's result
  return deliverable;
}
```

| Example | What it demonstrates |
|---------|---------------------|
| **hello.js** | Smallest possible workflow — one `agent()` call with a schema, `tools: []` |
| **data-pipeline.js** | Three sequential `agent()` calls, structured schemas, data flow via local vars |
| **tagline.js** | **agent → JS → agent** interleaving: brainstorm (model), shortlist (plain JS — no tokens), polish (model) |
| **code-review.js** | **`parallel()`** fan-out then fan-in, plus `phase()`/`log()`, personas, retries, budgets |

## Usage

```bash
# Copy an example into your project
cp examples/hello.js .pi/workflows/

# pi picks it up automatically — no /reload needed for workflows
pi

# Run it
/workflow hello

# Or with input
/workflow tagline a time-tracking app for freelancers
```

## Key patterns

- **Plain JS for anything mechanical** — transforms, filtering, sorting, fetching,
  computing. No model, no tokens. (Replaces the old `code` phase.)
- **`agent(prompt, opts)`** — one isolated sub-agent. Returns its final text, or
  the validated structured object when `opts.schema` is set. Default tools are
  `["read","bash","edit","write"]`; pass `tools: []` for pure reasoning.
- **Local variables** — capture an `agent()` result and reference it later
  (`const a = await agent(...)`). (Replaces `ctx.previous`.)
- **`args`** — the run's free-text input. (Replaces `ctx.input`.)
- **`parallel([...thunks])`** — run thunks concurrently and await all (barrier);
  results in input order, a thrown thunk yields `null`. (Replaces the `parallel`
  phase field.)
- **`phase(title)` / `log(msg)`** — progress grouping and narrator lines in
  `/workflows`. No tokens.

## The footgun

A model step meant to **return** an artifact (a report, a structured result)
must set a `schema`, and usually `tools: []` — otherwise the sub-agent may write
a file and answer in prose instead of returning the artifact. Default to plain
JS for mechanical work; reach for `agent()` only when the step needs judgment.
