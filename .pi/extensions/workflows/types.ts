/**
 * Workflows - Type definitions
 *
 * A workflow replaces the LLM orchestrator with code. Sub-agent outputs
 * flow from one phase to the next directly, never touching the main
 * context window.
 */

// ── Schema types ──────────────────────────────────────────────────────────

export interface SchemaField {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  /** When true, the phase output must contain this field (validated post-parse). */
  required?: boolean;
  items?: SchemaField;
  properties?: Record<string, SchemaField>;
}

export interface Schema {
  fields: Record<string, SchemaField>;
}

/**
 * A field can be written longhand (a {@link SchemaField}) or as a shorthand
 * string: `"<type>"`, with optional `[]` for an array of that type and a
 * trailing `!` to mark it required. Examples:
 *   "string"      → { type: "string" }
 *   "string!"     → required string
 *   "string[]"    → array of strings
 *   "number[]!"   → required array of numbers
 */
export type FieldSpec = string | SchemaField;

/**
 * What a phase's `schema` accepts. Either the longhand `{ fields: {...} }`
 * form, or a flat shorthand map `{ name: FieldSpec, ... }`. (A shorthand map
 * therefore cannot have a top-level field literally named `fields`.)
 */
export type SchemaInput = Schema | Record<string, FieldSpec>;

/** Thinking levels accepted by the underlying model. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh";

// ── Control flow types ────────────────────────────────────────────────────

export interface BudgetConfig {
  maxTokens?: number;
  maxCost?: number;
  maxTurns?: number;
}

export interface LoopConfig {
  maxIterations: number;
  condition: (ctx: PhaseContext) => boolean;
  /** Builds this iteration's prompt from the index (0-based) + ctx. If omitted,
   *  the phase's `prompt` is reused each iteration. */
  promptTemplate?: (index: number, ctx: PhaseContext) => string;
}

export interface PhaseContext {
  /** Results of all prior completed phases, keyed by phase name.
   *  For parallel results, use phaseName.subPhaseName. */
  previous: Record<string, any>;
  /** Free-text input supplied when the run was started (run_workflow's `input`
   *  param, or the args after `/workflow <name>`). Empty string if none. */
  input: string;
  workflow: WorkflowRunState;
}

// ── Phase definitions ─────────────────────────────────────────────────────

export interface ParallelPhaseDef {
  name: string;
  description?: string;
  agent?: string;
  /** Prompt for a sub-agent (a **model** sub-phase). String or function of ctx. */
  prompt?: string | ((ctx: PhaseContext) => string);
  /** Deterministic **code** sub-phase: plain JS, no model. Return value is the output. */
  code?: (ctx: PhaseContext) => any | Promise<any>;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  /** Thinking level for this sub-phase's sub-agent (overrides the agent's). */
  thinking?: ThinkingLevel;
  schema?: SchemaInput;
  timeout?: number;
}

export interface PhaseDefinition {
  name: string;
  description?: string;
  /** Named agent from ~/.pi/agent/agents/ or .pi/agents/ */
  agent?: string;
  /**
   * **Model phase.** The prompt sent to a sub-agent (a model). A static string,
   * or a function of `ctx` that builds the prompt from prior results / input.
   * Use a model phase when the step needs *judgment* (writing, reasoning,
   * analysis, extracting from messy input).
   */
  prompt?: string | ((ctx: PhaseContext) => string);
  /**
   * **Code phase.** Deterministic plain JS instead of a sub-agent. Receives the
   * same `ctx` (previous / input / workflow); its return value becomes the phase
   * output. No model, no tokens. Use a code phase for *mechanical* work —
   * transform, filter, sort, format, fetch, compute — and to interleave logic
   * between models (model → code → model).
   *
   * A phase needs exactly one of `prompt`, `code`, or `parallel`.
   */
  code?: (ctx: PhaseContext) => any | Promise<any>;
  model?: string;
  tools?: string[];
  systemPrompt?: string;
  /** Thinking level for this phase's sub-agent (overrides the agent's, default "off"). */
  thinking?: ThinkingLevel;
  schema?: SchemaInput;
  /** Run multiple sub-phases in parallel. Results keyed as phaseName.subName. */
  parallel?: ParallelPhaseDef[];
  /** Skip this phase if condition returns false. */
  condition?: (ctx: PhaseContext) => boolean;
  /** Loop execution. promptTemplate receives iteration index (0-based) + context. */
  loop?: LoopConfig;
  /** Number of automatic retries on failure (default 0). */
  retries?: number;
  /** Delay between retries in ms (default 2000). */
  retryDelay?: number;
  /** Max duration per attempt in ms. */
  timeout?: number;
  /** Budget limits for this phase. */
  budget?: BudgetConfig;
  /** Transform output before passing to subsequent phases. */
  map?: (result: any, ctx: PhaseContext) => any;
}

// ── Workflow definition ───────────────────────────────────────────────────

export interface WorkflowDefinition {
  name: string;
  description?: string;
  phases: PhaseDefinition[];
}

// ── Runtime state ─────────────────────────────────────────────────────────

export interface PhaseResult {
  phaseName: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  output?: any;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
  duration?: number;
  attempts?: number;
}

export interface WorkflowRunState {
  id: string;
  name: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phases: Record<string, PhaseResult>;
  currentPhase?: string;
  startTime: number;
  endTime?: number;
  error?: string;
}
