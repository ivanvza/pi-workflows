export const meta = {
  name: "data-pipeline",
  description: "Process data through discovery, transformation, and validation",
  phases: ["discover", "transform", "validate"],
};

export default async function ({ agent, phase, log, args }) {
  phase("Discover");
  const { sources } = await agent(
    "Discover all data sources and their formats in the project." +
      (args ? `\n\nFocus area: ${args}` : ""),
    {
      schema: {
        sources: {
          type: "array",
          description: "Data sources found",
          items: {
            type: "object",
            description: "A data source",
            properties: {
              path: "string",
              format: "string", // JSON | CSV | SQL | ...
              estimatedSize: "string", // small | medium | large
            },
          },
        },
      },
      label: "discover",
    },
  );
  log(`Discovered ${sources.length} data source(s)`);

  phase("Transform");
  const { transformations } = await agent(
    "Propose transformations to normalize these data sources (format conversion, schema " +
      "alignment, cleaning):\n\n" +
      JSON.stringify(sources),
    {
      schema: {
        transformations: {
          type: "array",
          description: "Proposed transformations",
          items: {
            type: "object",
            description: "A transformation",
            properties: { source: "string", operation: "string", output: "string" },
          },
        },
      },
      tools: [], // return-only: reasons over the passed-in JSON, writes nothing
      label: "transform",
    },
  );

  phase("Validate");
  const validation = await agent(
    "Review these proposed transformations for data-integrity risks; confirm no data loss " +
      "and that edge cases are handled:\n\n" +
      JSON.stringify(transformations),
    {
      schema: {
        valid: "boolean!",
        risks: "string[]",
        recommendations: "string[]",
      },
      tools: [], // pure reasoning over the passed-in JSON — no filesystem access
      label: "validate",
    },
  );
  return validation;
}
