/**
 * hello — the smallest possible workflow.
 *
 * A workflow file exports `meta` (name + description) and a default async
 * function that receives the runtime: { agent, parallel, pipeline, phase, log,
 * args, cwd, budget }. Each agent() call runs as an isolated sub-agent; results
 * flow through ordinary JS variables and never touch the main context window.
 * Run input arrives as `args`. The function's return value is the deliverable.
 *
 * Schemas accept a shorthand: "string", "string!" (required), "string[]"
 * (array), or the longhand `{ type, description, ... }` when descriptions help.
 *
 * Note `tools: []`: a step that only needs to *return* an answer should drop the
 * default file tools so it can't wander off editing files instead of answering.
 */

export const meta = {
  name: "hello",
  description: "The smallest possible workflow",
};

export default async function ({ agent, args }) {
  const { greeting } = await agent(
    args
      ? `Write a one-sentence friendly greeting for: ${args}`
      : "Write a one-sentence friendly greeting.",
    { schema: { greeting: "string!" }, tools: [], label: "greet" },
  );
  return greeting;
}
