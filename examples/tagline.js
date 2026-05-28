/**
 * tagline — a fast, self-contained demo of agent → CODE → agent.
 *
 *   brainstorm (prompt)  →  shortlist (code: plain JS)  →  polish (prompt)
 *
 * No tools or codebase needed — just pass a product as the run input:
 *   /workflow tagline a habit-tracking app for developers
 *
 * The middle phase calls no model: it cleans, dedupes, scores, and shortlists
 * the candidates in deterministic code, then hands three to the next agent.
 */

const tagline = {
  name: "tagline",
  description: "Brainstorm taglines, shortlist them in code, then polish the top picks",
  phases: [
    // 1. Agent: brainstorm candidates. tools: [] keeps it to pure generation.
    {
      name: "brainstorm",
      tools: [],
      prompt: (ctx) =>
        `Brainstorm 8 short, distinct, punchy marketing taglines for: ` +
        `${ctx.input || "a productivity app"}.`,
      schema: { candidates: "string[]!" },
    },

    // 2. Code phase: no model. Deterministically clean → dedupe → score → top 3.
    {
      name: "shortlist",
      code: (ctx) => {
        const raw = (ctx.previous.brainstorm?.candidates ?? [])
          .map((t) => t.trim())
          .filter(Boolean);

        // Dedupe case-insensitively, preserving order.
        const seen = new Set();
        const unique = [];
        for (const t of raw) {
          const key = t.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            unique.push(t);
          }
        }

        // Deterministic score: prefer taglines near ~40 characters.
        const score = (t) => 100 - Math.abs(40 - t.length);
        const ranked = [...unique].sort((a, b) => score(b) - score(a));
        const avgLength = Math.round(
          unique.reduce((s, t) => s + t.length, 0) / (unique.length || 1),
        );

        return { top: ranked.slice(0, 3), considered: unique.length, avgLength };
      },
      schema: { top: "string[]!", considered: "number", avgLength: "number" },
    },

    // 3. Agent: polish the code-selected shortlist into final picks.
    {
      name: "polish",
      tools: [],
      prompt: (ctx) => {
        const s = ctx.previous.shortlist;
        return (
          `Code shortlisted these top 3 of ${s.considered} candidates ` +
          `(avg length ${s.avgLength} chars):\n${JSON.stringify(s.top, null, 2)}\n\n` +
          `Polish them into final taglines. For each: the final text and a one-line rationale.`
        );
      },
      schema: {
        picks: {
          type: "array",
          description: "Final polished taglines",
          items: {
            type: "object",
            description: "a pick",
            properties: { tagline: "string", rationale: "string" },
          },
        },
      },
    },
  ],
};

export { tagline };
