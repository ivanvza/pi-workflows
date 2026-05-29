/**
 * Workflows — Type definitions (imperative format)
 *
 * A workflow is an async function that orchestrates isolated sub-agents in code.
 * The engine injects the primitives (agent / parallel / pipeline / phase / log);
 * the deterministic control flow — loops, conditionals, transforms — is plain JS
 * in the author's own function body. Sub-agent outputs flow through ordinary JS
 * variables and never touch the main context window.
 */

// ── Schema types ──────────────────────────────────────────────────────────

export interface SchemaField {
  type: "string" | "number" | "boolean" | "array" | "object";
  description: string;
  /** When true, the agent output must contain this field (validated post-parse). */
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
 * What an agent() call's `schema` accepts. Either the longhand `{ fields: {...} }`
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

// ── Config ────────────────────────────────────────────────────────────────

export interface BudgetConfig {
  maxTokens?: number;
  maxCost?: number;
  maxTurns?: number;
}

// ── Imperative authoring surface ──────────────────────────────────────────

/**
 * Per-call options for `agent()` — the surviving subset of the old
 * PhaseDefinition. Everything else (control flow, data flow, deterministic
 * work) is now plain JS in the workflow body.
 */
export interface AgentOptions {
  /** Named persona from `~/.pi/agent/agents` or `.pi/agents`. Supplies default
   *  model / tools / thinking / system prompt; the options below override it. */
  agent?: string;
  /** Model pattern (e.g. "claude-haiku-4-5"); overrides the persona's; falls
   *  back to the main session's model. */
  model?: string;
  /** Tool allowlist for this sub-agent. Default: `["read","bash","edit","write"]`.
   *  Use `[]` for a pure-reasoning agent that only returns a result. */
  tools?: string[];
  /** Thinking level; overrides the persona's. Default "off". */
  thinking?: ThinkingLevel;
  /** Extra system-prompt text, appended after the persona's. */
  systemPrompt?: string;
  /** When set, the sub-agent must deliver a structured object via the
   *  `provide_result` tool; agent() returns that validated object. */
  schema?: SchemaInput;
  /** Automatic retries on failure (default 0 → 1 attempt). A schema mismatch
   *  counts as a failure, so retries also re-roll bad structured output. */
  retries?: number;
  /** Delay between retries in ms (default 2000). */
  retryDelay?: number;
  /** Max duration per attempt in ms (default 300000). */
  timeout?: number;
  /** Budget for this call; merged over the run-level budget (this wins).
   *  Advisory — surfaced to the sub-agent as guidance, not hard-enforced. */
  budget?: BudgetConfig;
  /** Display name for this step in /workflows (replaces the old phase `name`).
   *  Unlabeled calls auto-number within the current phase() group. */
  label?: string;
}

/**
 * The single argument injected into a workflow's default-export function. All
 * orchestration happens through these primitives; everything else is plain JS.
 */
export interface WorkflowRuntime {
  /** Run one isolated sub-agent. Returns its final text, or — when `opts.schema`
   *  is set — the validated structured object. Throws on failure (after retries),
   *  so native `try/catch` works. */
  agent: (prompt: string, opts?: AgentOptions) => Promise<any>;
  /** Run thunks concurrently (a barrier — awaits all). Results come back in input
   *  order; a thunk that throws yields `null` in its slot (filter with
   *  `.filter(Boolean)`), and the failure is still visible as a failed step. */
  parallel: <T>(thunks: Array<() => Promise<T>>) => Promise<Array<T | null>>;
  /** Run each item through all stages independently (no barrier between items):
   *  stage k receives stage k-1's output for that item. Results in input order;
   *  an item whose chain throws yields `null` (others continue). */
  pipeline: (
    items: any[],
    ...stages: Array<(item: any, index: number) => any | Promise<any>>
  ) => Promise<any[]>;
  /** Open a named progress group; subsequent agent() steps show under it in
   *  /workflows. Pure progress/UX — no model, no tokens. */
  phase: (title: string) => void;
  /** Emit a narrator line shown in /workflows. No model, no tokens. */
  log: (msg: string) => void;
  /** Free-text input the run was started with (run_workflow's `input` param, or
   *  the args after `/workflow <name>`). Empty string if none. */
  args: string;
  /** Working directory the run was launched from. */
  cwd: string;
  /** Run-level default budget (per-call `opts.budget` overrides). */
  budget?: BudgetConfig;
}

/** Metadata exported alongside the default-export workflow function. */
export interface WorkflowMeta {
  /** Unique workflow id — the `/workflow <name>` key and discovery key. */
  name: string;
  /** Shown in /workflow-list and list_workflows. */
  description?: string;
  /** Display-only static flow hint for /workflow-list. Use a `"name⇉"` suffix to
   *  mark a parallel group. Ignored by the engine — live progress is built from
   *  phase()/agent() calls. Omit for a "dynamic" listing. */
  phases?: string[];
}

/** The default-export shape every workflow file provides. */
export type WorkflowFn = (rt: WorkflowRuntime) => Promise<any> | any;

/** Internal: a discovered, loaded workflow (engine-side, not authored). */
export interface LoadedWorkflow {
  name: string;
  description?: string;
  phases?: string[];
  fn: WorkflowFn;
}

// ── Runtime state ──────────────────────────────────────────────────────────

/** One recorded step (an agent() call) in a run. The shape is unchanged from
 *  the declarative era, so the run store, RPC readers, and the TUI are reused
 *  verbatim; `phaseName` is now the step's display label. */
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
  /** Steps keyed by display label, in call order (one per agent() call). */
  phases: Record<string, PhaseResult>;
  /** The current phase() group, shown in the below-editor run widget. */
  currentPhase?: string;
  /** The workflow function's return value — the run's deliverable. */
  result?: any;
  /** Narrator lines from log() — ephemeral progress, shown in /workflows. */
  logs?: string[];
  startTime: number;
  endTime?: number;
  error?: string;
}

/**
 * The on-disk form of a run, written one file per run to the run store
 * (`<project>/.pi/workflow-runs/<id>.json`, overridable via
 * `PI_WORKFLOWS_RUN_DIR`). It is a superset of {@link WorkflowRunState} plus
 * provenance so an external process — e.g. a frontend or orchestrator driving
 * pi over RPC — can list, watch, and read runs without touching pi's in-memory
 * state. Files are written atomically (write `*.json.tmp` then rename), so a
 * reader never observes a half-written file.
 *
 * `status` adds `"interrupted"`: a run whose owning process exited before it
 * reached a terminal state (detected on startup; see rehydrateRuns). It maps
 * back to a live `status: "failed"` when loaded into the in-memory registry.
 */
export interface PersistedRun {
  /** Bumped when this on-disk shape changes, so future readers can adapt. */
  schemaVersion: number;
  id: string;
  name: string;
  status: WorkflowRunState["status"] | "interrupted";
  phases: Record<string, PhaseResult>;
  currentPhase?: string;
  /** The workflow's deliverable (return value). Added in schemaVersion 2. */
  result?: any;
  startTime: number;
  endTime?: number;
  error?: string;
  /** The run's free-text input (run_workflow's `input` / `/workflow` args). */
  input: string;
  /** Working directory the run was launched from. */
  cwd: string;
  /** PID of the pi process that launched the run (for dead-owner detection). */
  pid: number;
  /** Session id at launch, if the host provided one (for optional filtering). */
  sessionId?: string;
  /** Denormalized token/cost/turn totals, so readers needn't re-sum phases. */
  usage: NonNullable<PhaseResult["usage"]>;
  /** Date.now() of the last write — used for throttling, sorting, and debug. */
  updatedAt: number;
}
