/**
 * tagline — a fast, self-contained demo of agent → JS → agent.
 *
 *   brainstorm (agent)  →  shortlist (plain JS)  →  polish (agent)
 *
 * No tools or codebase needed — just pass a product as the run input:
 *   /workflow tagline a habit-tracking app for developers
 *
 * The middle step calls no model: it cleans, dedupes, scores, and shortlists
 * the candidates in deterministic code, then hands three to the next agent.
 */

export const meta = {
  name: "tagline",
  description: "Brainstorm taglines, shortlist them in code, then polish the top picks",
  phases: ["brainstorm", "shortlist", "polish"],
};

export default async function ({ agent, phase, log, args }) {
  // 1. Agent: brainstorm candidates. tools: [] keeps it to pure generation.
  phase("Brainstorm");
  const { candidates } = await agent(
    `Brainstorm 8 short, distinct, punchy marketing taglines for: ${args || "a productivity app"}.`,
    { schema: { candidates: "string[]!" }, tools: [], label: "brainstorm" },
  );

  // 2. No model — deterministically clean → dedupe → score → top 3.
  const raw = candidates.map((t) => t.trim()).filter(Boolean);

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
  const top = [...unique].sort((a, b) => score(b) - score(a)).slice(0, 3);
  const avgLength = Math.round(
    unique.reduce((s, t) => s + t.length, 0) / (unique.length || 1),
  );
  log(`Shortlisted top 3 of ${unique.length} candidates (avg ${avgLength} chars)`);

  // 3. Agent: polish the code-selected shortlist into final picks.
  phase("Polish");
  const { picks } = await agent(
    `Code shortlisted these top 3 of ${unique.length} candidates ` +
      `(avg length ${avgLength} chars):\n${JSON.stringify(top, null, 2)}\n\n` +
      `Polish them into final taglines. For each: the final text and a one-line rationale.`,
    {
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
      tools: [],
      label: "polish",
    },
  );

  return picks;
}
