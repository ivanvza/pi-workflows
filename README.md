# pi-workflows

Code-driven multi-agent **workflow orchestration** for [pi](https://pi.dev).
Instead of letting the LLM decide what to do next every turn, you write the
control flow in plain JS — a default-exported `async` function that calls
isolated in-process sub-agents via an injected `agent()` (and runs them in
parallel with `parallel()` / `pipeline()`). Code handles the control flow; the
model only supplies judgment inside each `agent()` call.

```
use code for what code is good at  → control flow (what runs, when, in parallel)
use models for what models are good at → judgment (the actual work of each step)
```

Each sub-agent's transcript stays out of the main context window — only its
final structured output flows back into your code (as the return value of
`agent()`). Spin up ten sub-agents and the main session pays no per-step token
tax.

```js
export const meta = { name: "hello" };

export default async function ({ agent, args }) {
  const { greeting } = await agent(
    args ? `Greet: ${args}` : "Write a friendly greeting.",
    { schema: { greeting: "string!" }, tools: [], label: "greet" },
  );
  return greeting; // the function's return value IS the run's result
}
```

## What's in the package

- **Extension** (`.pi/extensions/workflows/`) — the engine: `run_workflow` /
  `list_workflows` / `get_workflow_result` tools and the `/workflow`,
  `/workflows`, `/workflow-list`, `/workflow-result` commands. Phases run via the
  pi SDK (`createAgentSession`) as isolated sub-agents.
- **Skill** (`.pi/skills/workflows/`) — teaches the agent how to **author**
  workflows in the imperative format, so you can just say *"build me a workflow
  that …"*.

## Install

```bash
pi install git:github.com/ivanvza/pi-workflows      # or your published location
pi install npm:pi-workflows
```

Or try it without installing:

```bash
pi -e git:github.com/ivanvza/pi-workflows
```

## Quick start

Copy an example into your project and run it:

```bash
cp examples/hello.js .pi/workflows/
```

Then in pi:

```
/workflow hello
```

In pi, type `/workflow hello` to run it. Pass input as trailing text —
`/workflow hello a habit tracker` — available to the workflow function as the
injected `args` string.

## Docs

- **Authoring guide (skill):** [`.pi/skills/workflows/SKILL.md`](.pi/skills/workflows/SKILL.md)
  and [recipes](.pi/skills/workflows/references/recipes.md)
- **Full reference:** [`.pi/extensions/workflows/README.md`](.pi/extensions/workflows/README.md)
- **Example workflows:** [`examples/`](examples/) (with agents in
  [`.pi/agents/`](.pi/agents/))

## License

MIT
