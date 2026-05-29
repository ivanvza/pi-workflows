# Workflow recipes

Copy-paste patterns in the imperative format: `export const meta` + `export default
async function`. Code drives control flow (if / for / parallel / pipeline);
`agent()` is reached for only when a step needs model judgment. All schemas use the
shorthand form (`"string!"`, `"string[]"`). See `../SKILL.md` for the full reference.

## 1. Parameterized run (use `args`)

`args` is the free-text input from `/workflow <name> <args…>`. Pass an isolated
sub-agent's structured result straight into the next as plain JS.

```js
export const meta = {
  name: "scout-and-plan",
  description: "Scout for a requested change, then plan it",
  phases: ["scout", "plan"],
};

export default async function ({ agent, args }) {
  const scout = await agent(
    `Find code relevant to this change:\n\n${args || "(survey the whole repo)"}`,
    { agent: "scout", schema: { relevantFiles: "string[]!", complexity: "string" }, retries: 1, label: "scout" },
  );

  const plan = await agent(
    `Plan this change: "${args}"\nRelevant files: ${JSON.stringify(scout.relevantFiles)}`,
    { agent: "planner", schema: { steps: "string[]!", risks: "string[]", estimatedEffort: "string" }, label: "plan" },
  );

  return plan;
}
```

Run: `/workflow scout-and-plan add rate limiting to the public API`

## 2. Conditional gate — skip expensive work when there's nothing to do

A native `if` replaces the old `condition` field. Declare the result up front so
downstream code can read it whether or not the branch ran.

```js
export const meta = { name: "scan-then-review", description: "Review only if the scan found issues" };

export default async function ({ agent }) {
  const scan = await agent("Scan the repo for problems.", {
    agent: "scout", schema: { issues: "string[]!" }, label: "scan",
  });

  let review = null;
  if (scan.issues.length > 0) {
    review = await agent(`Review these issues: ${JSON.stringify(scan.issues)}`, {
      agent: "reviewer", schema: { summary: "string!" }, label: "review",
    });
  }

  return { issues: scan.issues, review }; // review is null when the gate was skipped
}
```

## 3. Loop until a quality gate passes (iterative refinement)

A native `for` loop with `break` replaces the old `loop` config. `retries` is for
per-attempt reliability; this loop is for *re-running the judgment* until it's good.

```js
export const meta = { name: "tagline", description: "Draft and refine a tagline until self-approved" };

export default async function ({ agent, log }) {
  let draft = null;
  for (let i = 0; i < 4; i++) {
    draft = await agent(
      i === 0
        ? "Write a tagline. Self-rate it."
        : `Improve this tagline: "${draft.text}". Last critique: ${draft.critique}. Self-rate again.`,
      { schema: { text: "string!", approved: "boolean", critique: "string" }, tools: [], label: `draft ${i + 1}` },
    );
    log(`iteration ${i + 1}: approved=${draft.approved}`);
    if (draft.approved) break;
  }
  return draft;
}
```

## 4. Fan-out → fan-in (map-reduce)

`parallel()` runs thunks concurrently (barrier — awaits all) and returns results in
input order. A thunk that throws yields `null` in its slot, so one bad task never
aborts the batch — filter with `.filter(Boolean)`.

```js
export const meta = { name: "checks", description: "Parallel checks, then synthesize", phases: ["checks⇉", "synthesis"] };

export default async function ({ agent, parallel, phase }) {
  phase("Checks");
  const [lint, security, tests] = await parallel([
    () => agent("Find lint problems.",        { schema: { issues: "string[]" },   label: "lint" }),
    () => agent("Audit for vulnerabilities.", { schema: { findings: "string[]" }, label: "security" }),
    () => agent("Assess test coverage.",      { schema: { gaps: "string[]" },     label: "tests" }),
  ]);

  phase("Synthesis");
  return await agent(
    "Synthesize one report from:\n" +
      `Lint: ${JSON.stringify(lint)}\nSecurity: ${JSON.stringify(security)}\nTests: ${JSON.stringify(tests)}`,
    { agent: "reviewer", schema: { markdown: "string!" }, tools: [], label: "synthesis" },
  );
}
```

## 5. Native transform — shrink data between two models (no tokens)

The old `map` field is just JS on the returned value. Here a heavy first result is
reshaped to a slim list before it reaches the second model — exact, free, instant.

```js
export const meta = { name: "discover", description: "Discover sources, then plan ingestion from just the paths" };

export default async function ({ agent }) {
  const discovery = await agent("List every data source with full metadata.", {
    schema: { sources: { type: "array", description: "sources",
      items: { type: "object", description: "a source",
        properties: { path: "string", size: "number", meta: "object" } } } },
    label: "discover",
  });

  // deterministic transform — plain JS, no model, no tokens
  const paths = (discovery.sources ?? []).map((s) => s.path);

  return await agent(`Plan ingestion for these paths:\n${paths.join("\n")}`, {
    schema: { steps: "string[]!" }, tools: [], label: "plan",
  });
}
```

## 6. Persona-pinned recon, strong model for synthesis

A `scout` persona supplies a fast model + read-only tools for recon; the synthesis
step is left unpinned (inherits the session model) and gets the slim recon result.

```js
export const meta = { name: "recon-design", description: "Cheap recon, then design", phases: ["scan", "design"] };

export default async function ({ agent }) {
  const scan = await agent("Map the repo structure.", {
    agent: "scout", schema: { layout: "string!" }, label: "scan",
  });

  return await agent(`Design a refactor given:\n${scan.layout}`, {
    schema: { plan: "string!", risks: "string[]" }, label: "design",
  });
}
```

## 7. Read-only / sandboxed step

`tools: ["read"]` keeps a step from mutating anything; `tools: []` is pure
reasoning (no filesystem at all). Sub-agents already can't recurse into workflows.

```js
export const meta = { name: "summarize-file", description: "Summarize a file without touching it" };

export default async function ({ agent, args }) {
  const out = await agent(`Read ${args} and summarize it.`, {
    tools: ["read"], schema: { summary: "string!" }, label: "summarize",
  });
  return out.summary;
}
```

## 8. Flaky or slow step — retries + timeout

`agent()` throws after exhausting retries, so a native `try/catch` lets you degrade
gracefully. A retry fires on any failure: error stop, timeout, parse miss, or a
missing required schema field.

```js
export const meta = { name: "changelog", description: "Fetch a changelog, tolerate failure" };

export default async function ({ agent, log }) {
  try {
    return await agent("Fetch and extract the changelog from the project's site.", {
      agent: "researcher",
      retries: 2,       // 3 attempts total
      retryDelay: 3000, // 3s between tries
      timeout: 120000,  // fail an attempt after 2 min
      schema: { entries: "string[]!" },
      label: "fetch",
    });
  } catch (err) {
    log(`fetch failed: ${err.message}`);
    return { entries: [], error: String(err) };
  }
}
```

## 9. Pipeline over a list — each item flows through every stage

`pipeline(items, ...stages)` runs each item through all stages independently, with
no barrier between items. Stage `k` receives stage `k-1`'s output for that item; an
item whose chain throws yields `null` (others continue). Here recon → summary.

```js
export const meta = { name: "summarize-modules", description: "Recon then summarize each module independently" };

export default async function ({ agent, pipeline, args }) {
  const modules = args.split(",").map((m) => m.trim()).filter(Boolean);

  const results = await pipeline(
    modules,
    (mod) => agent(`Scan the ${mod} module.`,
      { agent: "scout", schema: { mod: "string", findings: "string[]!" }, label: `scan ${mod}` }),
    (scan) => agent(`Summarize findings for ${scan.mod}:\n${scan.findings.join("\n")}`,
      { schema: { summary: "string!" }, tools: [], label: `summary ${scan.mod}` }),
  );

  return results.filter(Boolean);
}
```

## 10. Optional enrichment with graceful degradation

Native `if` plus a nullable local variable: enrich only when there's something to
enrich, then branch the final prompt on whether the enrichment ran.

```js
export const meta = { name: "entity-report", description: "Extract, optionally enrich, then report" };

export default async function ({ agent }) {
  const extract = await agent("Extract entities.", { schema: { entities: "string[]!" }, label: "extract" });

  let enriched = null;
  if (extract.entities.length > 0) {
    const e = await agent(`Add context for: ${extract.entities.join(", ")}`, {
      schema: { enriched: "string[]" }, label: "enrich",
    });
    enriched = e.enriched;
  }

  const report = await agent(
    enriched
      ? `Write a report using: ${enriched.join("; ")}`
      : `Write a report from raw entities: ${extract.entities.join(", ")}`,
    { schema: { markdown: "string!" }, tools: [], label: "report" },
  );
  return report.markdown;
}
```

## 11. Budgets (advisory)

Passed to the sub-agent as instructions — not hard-enforced. Use to nudge brevity.
Per-call `budget` merges over the run-level default.

```js
const review = await agent("Synthesize the review.", {
  agent: "reviewer", schema: { summary: "string!" }, budget: { maxTokens: 50000, maxTurns: 8 }, label: "review",
});
```

## 12. Interleave deterministic code between models

There is no `code` phase anymore — deterministic work is just JS in the function
body: sort, filter, slice, count, fetch, compute. No model, no tokens.

```js
export const meta = { name: "triage", description: "Scan, prioritize in JS, then summarize the shortlist" };

const SEV = { high: 0, medium: 1, low: 2 };

export default async function ({ agent }) {
  // agent: gather raw data
  const scan = await agent("Find issues.", {
    agent: "scout",
    schema: { issues: { type: "array", description: "issues",
      items: { type: "object", description: "issue",
        properties: { severity: "string", file: "string", description: "string" } } } },
    label: "scan",
  });

  // plain JS: sort by severity, keep top 5, count — no model call
  const issues = scan.issues ?? [];
  const top = [...issues].sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9)).slice(0, 5);

  // agent: write from the clean shortlist
  return await agent(`Summarize the top issues (of ${issues.length} total): ${JSON.stringify(top)}`, {
    agent: "reviewer", schema: { markdown: "string!" }, tools: [], label: "summarize",
  });
}
```
