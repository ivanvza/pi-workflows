/**
 * data-pipeline — discover data sources, propose transformations, validate them.
 */

const dataPipeline = {
  name: "data-pipeline",
  description: "Process data through discovery, transformation, and validation",
  phases: [
    {
      name: "discover",
      prompt: "Discover all data sources and their formats in the project.",
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
    },
    {
      name: "transform",
      prompt: (ctx) =>
        "Propose transformations to normalize these data sources (format conversion, schema " +
        "alignment, cleaning):\n\n" +
        JSON.stringify(ctx.previous.discover.sources),
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
    },
    {
      name: "validate",
      prompt: (ctx) =>
        "Review these proposed transformations for data-integrity risks; confirm no data loss " +
        "and that edge cases are handled:\n\n" +
        JSON.stringify(ctx.previous.transform.transformations),
      schema: {
        valid: "boolean!",
        risks: "string[]",
        recommendations: "string[]",
      },
    },
  ],
};

export { dataPipeline };
