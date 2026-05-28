/**
 * code-review — analyze, run parallel checks, synthesize, and report.
 *
 * Optional input narrows the review, e.g.
 *   /workflow code-review focus on the auth module
 * available to phases as `ctx.input`.
 */

const codeReview = {
  name: "code-review",
  description: "Comprehensive code review: analysis, parallel checks, synthesis, report",
  phases: [
    {
      name: "analyze",
      agent: "scout",
      prompt: (ctx) =>
        "Analyze the codebase structure: key source files, their relationships, and the " +
        "overall architecture pattern." +
        (ctx.input ? `\n\nFocus area: ${ctx.input}` : ""),
      schema: {
        files: "string[]!",
        architecture: "string",
        modules: "string[]",
      },
      retries: 2,
    },
    {
      name: "parallel-checks",
      parallel: [
        {
          name: "lint-issues",
          prompt: "Scan for linting issues, style violations, and code-quality problems.",
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
        },
        {
          name: "security-audit",
          prompt:
            "Audit for security vulnerabilities: injection risks, hardcoded secrets, unsafe " +
            "dependencies, missing input validation, insecure configuration.",
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
        {
          name: "test-coverage",
          prompt:
            "Assess testing: what test files exist, which frameworks are used, what lacks coverage.",
          schema: {
            framework: "string", // or "none"
            testFiles: "string[]",
            uncoveredAreas: "string[]",
          },
        },
      ],
    },
    {
      name: "review",
      agent: "reviewer",
      prompt: (ctx) => {
        const c = ctx.previous["parallel-checks"]; // { lint-issues, security-audit, test-coverage }
        return (
          "Synthesize a comprehensive code review from these findings.\n\n" +
          `Architecture: ${JSON.stringify(ctx.previous.analyze)}\n` +
          `Lint: ${JSON.stringify(c["lint-issues"])}\n` +
          `Security: ${JSON.stringify(c["security-audit"])}\n` +
          `Tests: ${JSON.stringify(c["test-coverage"])}\n\n` +
          "Provide an executive summary, prioritized recommendations with severity, and a 1-10 health score."
        );
      },
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
    },
    {
      name: "report",
      prompt: (ctx) =>
        "Write a polished markdown report of the review below. Sections: architecture, issues, " +
        "recommendations, and health score. Output the full report as the `markdown` field.\n\n" +
        JSON.stringify(ctx.previous.review),
      schema: { markdown: "string!" },
    },
  ],
};

export { codeReview };
