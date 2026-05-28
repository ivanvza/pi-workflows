/**
 * hello — the smallest possible workflow.
 *
 * A workflow is `{ name, description?, phases: [...] }`. Each phase runs as an
 * isolated sub-agent; outputs flow phase→phase in code via `ctx.previous` and
 * never touch the main context window. Pass run input via `ctx.input`.
 *
 * Schemas accept a shorthand: "string", "string!" (required), "string[]"
 * (array), or the longhand `{ type, description, ... }` when descriptions help.
 */

const hello = {
  name: "hello",
  description: "The smallest possible workflow",
  phases: [
    {
      name: "greet",
      prompt: (ctx) =>
        ctx.input
          ? `Write a one-sentence friendly greeting for: ${ctx.input}`
          : "Write a one-sentence friendly greeting.",
      schema: { greeting: "string!" },
    },
  ],
};

export { hello };
