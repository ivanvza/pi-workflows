# Workflow recipes

Copy-paste patterns. All use the shorthand schema (`"string!"`, `"string[]"`) and
`ctx` (`ctx.previous`, `ctx.input`). See `../SKILL.md` for the full field reference.

## 1. Parameterized run (use `ctx.input`)

```js
const scoutAndPlan = {
  name: "scout-and-plan",
  description: "Scout for a requested change, then plan it",
  phases: [
    { name: "scout", agent: "scout",
      prompt: (ctx) => `Find code relevant to this change:\n\n${ctx.input || "(survey the whole repo)"}`,
      schema: { relevantFiles: "string[]!", complexity: "string" },
      retries: 1 },
    { name: "plan", agent: "planner",
      prompt: (ctx) =>
        `Plan this change: "${ctx.input}"\n` +
        `Relevant files: ${JSON.stringify(ctx.previous.scout.relevantFiles)}`,
      schema: { steps: "string[]!", risks: "string[]", estimatedEffort: "string" } },
  ],
};
export { scoutAndPlan };
```

Run: `/workflow scout-and-plan add rate limiting to the public API`

## 2. Conditional gate — skip expensive work when there's nothing to do

```js
{ name: "review", agent: "reviewer",
  prompt: (ctx) => `Review these issues: ${JSON.stringify(ctx.previous.scan.issues)}`,
  condition: (ctx) => (ctx.previous.scan?.issues?.length ?? 0) > 0 }
```

A skipped phase produces no output — read it defensively downstream
(`ctx.previous.review?.x ?? fallback`).

## 3. Loop until a quality gate passes (iterative refinement)

`loop.condition` means "keep going"; it's checked before each iteration after the
first and sees the latest output via `ctx.previous`. `maxIterations` guarantees
termination. Only the final iteration is stored.

```js
{ name: "draft",
  loop: {
    maxIterations: 4,
    condition: (ctx) => ctx.previous.draft?.approved !== true,
    promptTemplate: (i, ctx) =>
      i === 0
        ? "Write a tagline. Self-rate it."
        : `Improve this tagline: "${ctx.previous.draft.text}". ` +
          `Last critique: ${ctx.previous.draft.critique}. Self-rate again.`,
  },
  schema: { text: "string!", approved: "boolean", critique: "string" } }
```

## 4. Fan-out → fan-in (map-reduce)

Sub-phases run concurrently (max 8; global cap 6 sub-agents). Each sees only prior
*completed* phases, never siblings. Results nest under the parent name.

```js
phases: [
  { name: "checks", parallel: [
      { name: "lint",     prompt: "Find lint problems.",        schema: { issues: "string[]" } },
      { name: "security", prompt: "Audit for vulnerabilities.", schema: { findings: "string[]" } },
      { name: "tests",    prompt: "Assess test coverage.",      schema: { gaps: "string[]" } },
  ] },
  { name: "synthesis", agent: "reviewer",
    prompt: (ctx) => {
      const c = ctx.previous.checks; // { lint, security, tests }
      return "Synthesize one report from:\n" +
        `Lint: ${JSON.stringify(c.lint)}\nSecurity: ${JSON.stringify(c.security)}\n` +
        `Tests: ${JSON.stringify(c.tests)}`;
    } },
]
```

## 5. `map` — shrink data before it hits the next prompt

```js
{ name: "discover",
  prompt: "List every data source with full metadata.",
  schema: { sources: { type: "array", description: "sources",
    items: { type: "object", description: "a source",
      properties: { path: "string", size: "number", meta: "object" } } } },
  map: (result) => result.sources.map((s) => s.path), // downstream sees just paths
}
```

## 6. Mix models — cheap for recon, strong for synthesis

```js
phases: [
  { name: "scan",   model: "claude-haiku-4-5", tools: ["read","grep"],
    prompt: "Map the repo structure.", schema: { layout: "string!" } },
  { name: "design", model: "claude-opus-4-5",
    prompt: (ctx) => `Design a refactor given: ${JSON.stringify(ctx.previous.scan)}` },
]
```

## 7. Read-only / sandboxed phase

```js
{ name: "summarize", tools: ["read"],
  prompt: (ctx) => `Summarize: ${ctx.previous.scan.summary}` }
```

`tools: ["read"]` keeps a phase from mutating anything. (Sub-agents already can't
recurse into `run_workflow`.)

## 8. Flaky or slow phase — retries + timeout

```js
{ name: "fetch", agent: "researcher",
  prompt: "Fetch and extract the changelog from the project's site.",
  retries: 2,        // 3 attempts total
  retryDelay: 3000,  // 3s between tries
  timeout: 120000 }  // fail an attempt after 2 min
```

A retry fires on any failure: error stop reason, timeout, a parse miss, or a
missing required schema field.

## 9. Optional enrichment with graceful degradation

```js
phases: [
  { name: "extract", prompt: "Extract entities.", schema: { entities: "string[]!" } },
  { name: "enrich",
    condition: (ctx) => ctx.previous.extract.entities.length > 0,
    prompt: (ctx) => `Add context for: ${ctx.previous.extract.entities.join(", ")}`,
    schema: { enriched: "string[]" } },
  { name: "report",
    prompt: (ctx) => {
      const enriched = ctx.previous.enrich?.enriched; // may be undefined if skipped
      return enriched
        ? `Write a report using: ${enriched.join("; ")}`
        : `Write a report from raw entities: ${ctx.previous.extract.entities.join(", ")}`;
    } },
]
```

## 10. Budgets (advisory)

Passed to the sub-agent as instructions — not hard-enforced. Use to nudge brevity.

```js
{ name: "review", agent: "reviewer", prompt: "...", budget: { maxTokens: 50000, maxTurns: 8 } }
```

## 11. Interleave deterministic code between models (`code`)

A `code` phase executes plain JS — no model, no tokens — so you can do exact,
deterministic work between model phases: `prompt → code → prompt`.

```js
const SEV = { high: 0, medium: 1, low: 2 };

phases: [
  // agent: gather raw data
  { name: "scan", agent: "scout", prompt: "Find issues.",
    schema: { issues: { type: "array", description: "issues",
      items: { type: "object", description: "issue",
        properties: { severity: "string", file: "string", description: "string" } } } } },

  // code: sort by severity, keep top 5, count — no LLM call
  { name: "prioritize",
    code: (ctx) => {
      const issues = ctx.previous.scan?.issues ?? [];
      const sorted = [...issues].sort((a, b) => (SEV[a.severity] ?? 9) - (SEV[b.severity] ?? 9));
      return { top: sorted.slice(0, 5), total: issues.length };
    },
    schema: { top: "object[]!", total: "number" } },  // optional: validate the return shape

  // agent: write from the clean shortlist
  { name: "summarize", agent: "reviewer",
    prompt: (ctx) => `Summarize the top issues: ${JSON.stringify(ctx.previous.prioritize.top)}` },
]
```

`code` can be `async` (e.g. call your own API). `retries` apply if it throws.
`model`/`tools`/`thinking`/`budget`/`agent` are ignored for a code phase. See the
runnable `triage` workflow in `.pi/workflows/triage.js`.
