/**
 * code-review — analyze, run parallel checks, synthesize, and report.
 *
 * Optional input narrows the review, e.g.
 *   /workflow code-review focus on the auth module
 * It arrives as `args`.
 *
 * Shows the whole imperative toolkit: phase() grouping, a named agent persona,
 * structured schemas, retries, parallel() fan-out, a deterministic native-JS
 * transform between models (no tokens), a budget hint, and returning the
 * deliverable. Control flow is plain JS — there are no special phase fields.
 */

export const meta = {
  name: "code-review",
  description: "Comprehensive code review: analysis, parallel checks, synthesis, report",
  // Display-only flow hint for /workflow-list (⇉ marks the parallel group).
  phases: ["analyze", "checks⇉", "review", "report"],
};

export default async function ({ agent, parallel, phase, log, args }) {
  // ── Analyze: a fast scout persona, retried, returns structure ────────────
  phase("Analyze");
  const analysis = await agent(
    "Analyze the codebase structure: key source files, their relationships, and the " +
      "overall architecture pattern." +
      (args ? `\n\nFocus area: ${args}` : ""),
    {
      agent: "scout",
      schema: { files: "string[]!", architecture: "string", modules: "string[]" },
      retries: 2,
      label: "analyze",
    },
  );
  log(`Analyzed ${analysis.files.length} source files`);

  // ── Parallel checks: three independent audits at once (barrier) ──────────
  phase("Checks");
  const [lint, security, tests] = await parallel([
    () =>
      agent("Scan for linting issues, style violations, and code-quality problems.", {
        label: "lint",
        schema: {
          issues: {
            type: "array",
            description: "Lint / quality issues found",
            items: {
              type: "object",
              description: "An issue",
              properties: { file: "string", line: "number", description: "string" },
            },
          },
          summary: "string",
        },
      }),
    () =>
      agent(
        "Audit for security vulnerabilities: injection risks, hardcoded secrets, unsafe " +
          "dependencies, missing input validation, insecure configuration.",
        {
          label: "security",
          schema: {
            vulnerabilities: {
              type: "array",
              description: "Vulnerabilities found",
              items: {
                type: "object",
                description: "A vulnerability",
                properties: {
                  severity: "string", // high | medium | low
                  type: "string",
                  location: "string",
                  description: "string",
                },
              },
            },
            riskLevel: "string", // high | medium | low
          },
        },
      ),
    () =>
      agent("Assess testing: which test files exist, frameworks used, and what lacks coverage.", {
        label: "tests",
        schema: { framework: "string", testFiles: "string[]", uncoveredAreas: "string[]" },
      }),
  ]);

  // ── Deterministic transform (native JS — no model, no tokens) ────────────
  // Order vulnerabilities by severity so the synthesis prompt leads with the worst.
  const RANK = { high: 0, medium: 1, low: 2 };
  const vulns = (security?.vulnerabilities ?? [])
    .slice()
    .sort((a, b) => (RANK[a.severity] ?? 9) - (RANK[b.severity] ?? 9));

  // ── Synthesize: a heavier reviewer persona with a budget hint ────────────
  phase("Review");
  const review = await agent(
    "Synthesize a comprehensive code review from these findings.\n\n" +
      `Architecture: ${JSON.stringify(analysis)}\n` +
      `Lint: ${JSON.stringify(lint ?? {})}\n` +
      `Security (worst first): ${JSON.stringify(vulns)}\n` +
      `Tests: ${JSON.stringify(tests ?? {})}\n\n` +
      "Provide an executive summary, prioritized recommendations with severity, and a 1-10 health score.",
    {
      agent: "reviewer",
      schema: {
        executiveSummary: "string!",
        recommendations: {
          type: "array",
          description: "Prioritized recommendations",
          items: {
            type: "object",
            description: "A recommendation",
            properties: {
              priority: "number", // 1 = highest
              category: "string", // lint | security | testing | architecture
              description: "string",
              effort: "string", // low | medium | high
            },
          },
        },
        healthScore: "number",
      },
      budget: { maxTokens: 50000 },
      label: "review",
    },
  );

  // ── Report: the returned value is the run's deliverable ──────────────────
  phase("Report");
  const report = await agent(
    "Write a polished markdown report of the review below. Sections: architecture, issues, " +
      "recommendations, and health score. Output the full report as the `markdown` field.\n\n" +
      JSON.stringify(review),
    { schema: { markdown: "string!" }, tools: [], label: "report" },
  );

  return report.markdown;
}
