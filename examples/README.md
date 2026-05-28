# Example Workflows

Copy any of these into your project's `.pi/workflows/` to run them.

| Example | What it demonstrates |
|---------|---------------------|
| **hello.js** | Simplest possible workflow — single prompt phase with schema |
| **data-pipeline.js** | Three prompt phases, structured schemas, cross-phase data flow via `ctx.previous` |
| **tagline.js** | **Agent → code → agent** interleaving: brainstorm (LLM), shortlist (deterministic JS), polish (LLM) |
| **code-review.js** | **Parallel** phases fanning out, then fanning in — plus agents, retries, budgets |

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

- **`code` phases** — deterministic JS, no model tokens. Use for transforms, filtering, API calls.
- **`prompt` phases** — model judgment. Add a `schema` so the phase returns structured data.
- **`ctx.previous.<name>`** — read a prior phase's output. `ctx.input` is the run's free-text input.
- **`parallel: [...]`** — run sub-phases concurrently; fan in with `ctx.previous.<parent>.<sub>`.
