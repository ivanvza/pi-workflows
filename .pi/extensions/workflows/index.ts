/**
 * Workflows Extension — Code-driven multi-agent orchestration
 *
 * Replaces the LLM orchestrator with a JS-defined workflow. Sub-agent outputs
 * flow from phase to phase directly, never touching the main context window.
 *
 * Features:
 *   - Phases with structured schemas (predictable outputs)
 *   - Parallel fan-out + streaming pipelines
 *   - Conditionals, loops, and budgets in real JS
 *   - Automatic retries on failure
 *   - Live progress view via /workflows
 *   - Background execution support
 *
 * Each phase runs as an isolated in-process sub-agent (pi SDK
 * `createAgentSession` with an in-memory session + a resource loader that loads
 * no extensions), so a phase can't recursively trigger workflows and its
 * transcript never enters the main context window.
 *
 * Usage:
 *   1. Define workflows in .pi/workflows/*.js
 *   2. The LLM calls run_workflow with a workflow name (+ optional input)
 *   3. The engine runs a sub-agent per phase, orchestrates flow in code
 *   4. Use /workflows to see live progress
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message, Model } from "@earendil-works/pi-ai";
import {
  AuthStorage,
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  getAgentDir,
  ModelRegistry,
  parseFrontmatter,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type {
  AgentOptions,
  BudgetConfig,
  FieldSpec,
  LoadedWorkflow,
  PersistedRun,
  PhaseResult,
  Schema,
  SchemaField,
  SchemaInput,
  ThinkingLevel,
  WorkflowFn,
  WorkflowMeta,
  WorkflowRunState,
  WorkflowRuntime,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

// Max items a single parallel()/pipeline() call dispatches at once. The global
// semaphore (GLOBAL_MAX_AGENTS) is the real ceiling on concurrent sub-agents;
// this just bounds how aggressively one fan-out call queues work. Arbitrarily
// long input arrays are fine — excess items queue and run as slots free up.
const MAX_CONCURRENCY = 4;
const DEFAULT_RETRY_DELAY = 2000;
const PHASE_TIMEOUT_MS = 300_000; // 5 min default

// Global ceiling on concurrent sub-agent sessions across ALL running
// workflows. Without this, N simultaneous workflows × their parallel phases
// could open unbounded sub-agent sessions and swamp the machine / rate limits.
const GLOBAL_MAX_AGENTS = 6;

// ═══════════════════════════════════════════════════════════════════════════
// Global sub-agent semaphore (shared across all concurrent workflow runs)
// ═══════════════════════════════════════════════════════════════════════════

let activeAgents = 0;
const agentWaiters: Array<() => void> = [];

/** Acquire one global sub-agent slot, waiting if all are in use. */
async function acquireAgentSlot(): Promise<void> {
  if (activeAgents < GLOBAL_MAX_AGENTS) {
    activeAgents++;
    return;
  }
  // Wait until a slot is handed to us. The releasing caller keeps the slot
  // accounted (does not decrement), so we must not increment here.
  await new Promise<void>((resolve) => agentWaiters.push(resolve));
}

/** Release a global sub-agent slot, handing it directly to the next waiter. */
function releaseAgentSlot(): void {
  const next = agentWaiters.shift();
  if (next) {
    next(); // transfer the slot; activeAgents stays the same
  } else {
    activeAgents--;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function generateId(): string {
  return `wf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

// ── Usage accumulation ─────────────────────────────────────────────────────

type Usage = NonNullable<PhaseResult["usage"]>;

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: Usage, u: PhaseResult["usage"]): void {
  if (!u) return;
  target.input += u.input || 0;
  target.output += u.output || 0;
  target.cacheRead += u.cacheRead || 0;
  target.cacheWrite += u.cacheWrite || 0;
  target.cost += u.cost || 0;
  target.turns += u.turns || 0;
}

function totalRunUsage(run: WorkflowRunState): Usage {
  const total = emptyUsage();
  for (const pr of Object.values(run.phases)) addUsage(total, pr.usage);
  return total;
}

function formatUsage(u: Usage): string {
  const tokens = u.input + u.output;
  if (tokens === 0 && u.cost === 0) return "";
  const parts = [`${formatTokens(tokens)} tok`];
  if (u.cost > 0) parts.push(`$${u.cost.toFixed(3)}`);
  if (u.turns > 0) parts.push(`${u.turns} turns`);
  return parts.join(" · ");
}

/** Compact "time since" label for a run (since it ended, else since it started),
 *  e.g. "12s ago", "4m ago", "2h ago", "3d ago". Used in the run picker. */
function ageStr(run: WorkflowRunState): string {
  const s = Math.max(0, Math.round((Date.now() - (run.endTime ?? run.startTime)) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Agent Discovery
// ═══════════════════════════════════════════════════════════════════════════

interface AgentConfig {
  name: string;
  description?: string;
  model?: string;
  tools?: string[];
  thinking?: ThinkingLevel;
  systemPrompt: string;
  source: "user" | "project";
}

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
  if (!value) return undefined;
  const v = value.trim().toLowerCase();
  return THINKING_LEVELS.has(v) ? (v as ThinkingLevel) : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
  const agents: AgentConfig[] = [];
  if (!fs.existsSync(dir)) return agents;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return agents;
  }
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, entry.name), "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name) continue;
    const tools = frontmatter.tools
      ?.split(",")
      .map((t: string) => t.trim())
      .filter(Boolean);
    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      model: frontmatter.model,
      tools: tools && tools.length > 0 ? tools : undefined,
      thinking: parseThinking(frontmatter.thinking),
      systemPrompt: body,
      source,
    });
  }
  return agents;
}

function findProjectAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "agents");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not here, walk up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Discover agents from ~/.pi/agent/agents (user) and .pi/agents (project).
 *  Project agents override user agents of the same name. */
function discoverAgents(cwd: string): Map<string, AgentConfig> {
  const map = new Map<string, AgentConfig>();
  for (const a of loadAgentsFromDir(path.join(getAgentDir(), "agents"), "user")) {
    map.set(a.name, a);
  }
  const projectDir = findProjectAgentsDir(cwd);
  if (projectDir) {
    for (const a of loadAgentsFromDir(projectDir, "project")) map.set(a.name, a);
  }
  return map;
}

// ═══════════════════════════════════════════════════════════════════════════
// Model Resolution
// ═══════════════════════════════════════════════════════════════════════════

// Auth + model registry are created once and shared across all sub-agent
// sessions. They read ~/.pi/agent/{auth.json,models.json} exactly like the main
// session, so a phase sees the same models and credentials the user has.
let _authStorage: AuthStorage | null = null;
let _modelRegistry: ModelRegistry | null = null;

function getAuthStorage(): AuthStorage {
  if (!_authStorage) _authStorage = AuthStorage.create();
  return _authStorage;
}

function getModelRegistry(): ModelRegistry {
  if (!_modelRegistry) _modelRegistry = ModelRegistry.create(getAuthStorage());
  return _modelRegistry;
}

/** The main session's current model, captured from events. Used as the default
 *  for phases (and agents) that don't pin their own model. */
let defaultModel: Model<any> | undefined;

/**
 * Resolve a pi model pattern (e.g. "claude-haiku-4-5", "deepseek-v4-flash:cloud",
 * "anthropic/claude-opus-4-5") to a concrete Model, matching pi's CLI rules as
 * closely as the public registry API allows. Returns undefined if nothing
 * matches, so callers can fall back to the default model.
 *
 * Strategy, against registry.getAll():
 *   1. exact `provider/id`
 *   2. exact `id` (unambiguous)
 *   3. exact `name`
 *   4. partial `id`/`name` contains, preferring an alias (id with no trailing date)
 *   5. if the pattern has a trailing `:suffix`, retry on the prefix (covers
 *      `model:cloud` style provider/flavor suffixes and `model:thinkingLevel`)
 */
function resolveModelPattern(pattern: string): Model<any> | undefined {
  const all = getModelRegistry().getAll();
  const tryMatch = (p: string): Model<any> | undefined => {
    const slash = p.indexOf("/");
    if (slash > 0) {
      const provider = p.slice(0, slash);
      const id = p.slice(slash + 1);
      const m = all.find((x) => x.provider === provider && x.id === id);
      if (m) return m;
    }
    const byId = all.filter((x) => x.id === p);
    if (byId.length === 1) return byId[0];
    const byName = all.find((x) => x.name === p);
    if (byName) return byName;
    const partial = all.filter(
      (x) => x.id.includes(p) || (x.name?.includes(p) ?? false),
    );
    if (partial.length > 0) {
      // Prefer an alias (no trailing -YYYYMMDD date) over dated variants.
      const alias = partial.find((x) => !/-\d{8}$/.test(x.id));
      return alias ?? partial[0];
    }
    return undefined;
  };

  const direct = tryMatch(pattern);
  if (direct) return direct;

  const lastColon = pattern.lastIndexOf(":");
  if (lastColon > 0) return tryMatch(pattern.slice(0, lastColon));
  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Schema Normalization (shorthand → full Schema)
// ═══════════════════════════════════════════════════════════════════════════

const SCALAR_TYPES = new Set(["string", "number", "boolean", "array", "object"]);

/** Parse a shorthand string like "string", "string!", "number[]", "string[]!". */
function parseShorthandField(spec: string): SchemaField {
  let s = spec.trim();
  let required = false;
  if (s.endsWith("!")) {
    required = true;
    s = s.slice(0, -1).trim();
  }
  let isArray = false;
  if (s.endsWith("[]")) {
    isArray = true;
    s = s.slice(0, -2).trim();
  }
  if (!SCALAR_TYPES.has(s)) {
    throw new Error(
      `Invalid schema shorthand "${spec}". Use one of string|number|boolean|object|array, optionally suffixed with [] and/or !.`,
    );
  }
  const base = s as SchemaField["type"];
  if (isArray) {
    return { type: "array", description: "", required, items: { type: base, description: "" } };
  }
  return { type: base, description: "", required };
}

/** Normalize a single field spec (string shorthand or object) into a SchemaField. */
function normalizeField(spec: FieldSpec): SchemaField {
  if (typeof spec === "string") return parseShorthandField(spec);
  const field: SchemaField = { ...spec };
  if (field.items) field.items = normalizeField(field.items as FieldSpec);
  if (field.properties) {
    const props: Record<string, SchemaField> = {};
    for (const [k, v] of Object.entries(field.properties)) {
      props[k] = normalizeField(v as FieldSpec);
    }
    field.properties = props;
  }
  return field;
}

/** Accept either `{ fields: {...} }` (longhand) or a flat shorthand map and
 *  return a fully-formed Schema. A shorthand map cannot have a field named
 *  `fields` (that key signals the longhand form). */
function normalizeSchema(input: SchemaInput): Schema {
  const raw: Record<string, FieldSpec> =
    "fields" in input &&
    typeof (input as Schema).fields === "object" &&
    !Array.isArray((input as Schema).fields)
      ? ((input as Schema).fields as Record<string, FieldSpec>)
      : (input as Record<string, FieldSpec>);
  const fields: Record<string, SchemaField> = {};
  for (const [name, spec] of Object.entries(raw)) {
    fields[name] = normalizeField(spec);
  }
  return { fields };
}

// ═══════════════════════════════════════════════════════════════════════════
// Structured Output via Tool Call
//
// Prompt-based "emit a ```json block" is unreliable — a fast model on a simple
// task will just answer in prose. Instead we hand the sub-agent a `provide_result`
// tool whose parameters ARE the schema. Models emit tool calls reliably, and pi
// validates the arguments, so the structured result comes back as the tool's
// captured arguments. (We still fall back to text JSON extraction if needed.)
// ═══════════════════════════════════════════════════════════════════════════

const RESULT_TOOL_NAME = "provide_result";

/** Convert one schema field to a TypeBox schema (with descriptions preserved). */
function fieldToTypeBox(field: SchemaField): any {
  const opts = field.description ? { description: field.description } : {};
  switch (field.type) {
    case "string":
      return Type.String(opts);
    case "number":
      return Type.Number(opts);
    case "boolean":
      return Type.Boolean(opts);
    case "array":
      return Type.Array(field.items ? fieldToTypeBox(field.items) : Type.Any(), opts);
    case "object":
      if (field.properties) {
        const props: Record<string, any> = {};
        for (const [k, v] of Object.entries(field.properties)) {
          props[k] = v.required ? fieldToTypeBox(v) : Type.Optional(fieldToTypeBox(v));
        }
        return Type.Object(props, opts);
      }
      return Type.Object({}, { ...opts, additionalProperties: true });
    default:
      return Type.Any();
  }
}

/** Build the TypeBox parameter object for the provide_result tool from a Schema. */
function schemaToTypeBox(schema: Schema): any {
  const props: Record<string, any> = {};
  for (const [name, field] of Object.entries(schema.fields)) {
    props[name] = field.required ? fieldToTypeBox(field) : Type.Optional(fieldToTypeBox(field));
  }
  return Type.Object(props);
}

/** Instruction telling the sub-agent to deliver its answer via the tool. */
function schemaToolPrompt(): string {
  return (
    "OUTPUT: When you have finished the task, call the `provide_result` tool exactly " +
    "once with your final answer. Its parameters define the required output structure. " +
    "Deliver the structured result ONLY through that tool — do not also write it as prose."
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON Extraction
// ═══════════════════════════════════════════════════════════════════════════

function extractJsonFromText(text: string): any | null {
  // Try ```json block first
  const jsonBlockMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    try {
      return JSON.parse(jsonBlockMatch[1]);
    } catch { /* continue */ }
  }

  // Try any ``` block
  const anyBlockMatch = text.match(/```\s*([\s\S]*?)\s*```/);
  if (anyBlockMatch) {
    try {
      return JSON.parse(anyBlockMatch[1]);
    } catch { /* continue */ }
  }

  // Try to find a JSON object directly
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch { /* continue */ }
  }

  return null;
}

function getFinalAssistantText(messages: Message[]): string {
  // Find the last assistant message that actually carries text. The final
  // assistant turn can be a tool call with no text, so we can't just take
  // the last assistant message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    const texts = msg.content.filter((p) => p.type === "text").map((p) => p.text);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

/** Validate parsed output against a schema. Throws (retryable) on a mismatch. */
function validateSchema(schema: Schema, value: any, phaseName: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Phase "${phaseName}" output is not a JSON object.`);
  }
  const missing: string[] = [];
  for (const [name, field] of Object.entries(schema.fields)) {
    if (field.required && (value[name] === undefined || value[name] === null)) {
      missing.push(name);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `Phase "${phaseName}" output is missing required field(s): ${missing.join(", ")}`,
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Subagent Execution (per phase)
// ═══════════════════════════════════════════════════════════════════════════

interface SubagentResult {
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: PhaseResult["usage"];
  stopReason?: string;
  errorMessage?: string;
  /** Structured output captured from the provide_result tool call, if any. */
  structured?: any;
}

/** Sum token/cost usage across the assistant messages of a finished session. */
function collectUsage(messages: Message[]): Usage {
  const u = emptyUsage();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    const mu = (m as any).usage;
    if (!mu) continue;
    u.turns += 1;
    u.input += mu.input || 0;
    u.output += mu.output || 0;
    u.cacheRead += mu.cacheRead || 0;
    u.cacheWrite += mu.cacheWrite || 0;
    u.cost += mu.cost?.total || 0;
  }
  return u;
}

/** The stop reason / error of the final assistant message, if any. */
function lastAssistantStatus(messages: Message[]): {
  stopReason?: string;
  errorMessage?: string;
} {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      return { stopReason: (m as any).stopReason, errorMessage: (m as any).errorMessage };
    }
  }
  return {};
}

/** Build a fully-isolated ResourceLoader: no extensions (so a phase can't
 *  recursively load this workflows extension), no skills/prompts/themes/context
 *  files. Tools come from createAgentSession's `tools` option; this loader only
 *  supplies the system prompt. */
function isolatedResourceLoader(systemPrompt: string): any {
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

/**
 * Run a single phase as an in-process sub-agent via the pi SDK
 * (`createAgentSession`). The sub-agent gets its own in-memory session and a
 * fully isolated resource loader, so its transcript never touches the main
 * session's context window and it cannot recursively trigger workflows.
 */
async function runSubagent(
  cwd: string,
  prompt: string,
  model: string | undefined,
  tools: string[] | undefined,
  systemPromptExtra: string | undefined,
  schema: Schema | undefined,
  budget: BudgetConfig | undefined,
  thinking: ThinkingLevel | undefined,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<SubagentResult> {
  // When a schema is set, hand the sub-agent a `provide_result` tool whose
  // parameters are the schema; its captured arguments become the output. This
  // is far more reliable than prompting for a ```json block.
  let capturedStructured: any;
  let activeTools = tools;
  const customTools: any[] = [];
  if (schema) {
    const resultTool = defineTool({
      name: RESULT_TOOL_NAME,
      label: "Provide Result",
      description:
        "Submit your final structured result for this task. Call this exactly once when done.",
      parameters: schemaToTypeBox(schema),
      execute: async (_id: string, params: any) => {
        capturedStructured = params;
        return { content: [{ type: "text", text: "Result recorded." }], details: {} };
      },
    });
    customTools.push(resultTool);
    // The result tool must be in the active allowlist alongside whatever the
    // phase needs to do its work (default built-ins when unrestricted).
    const base = tools ?? ["read", "bash", "edit", "write"];
    activeTools = [...base, RESULT_TOOL_NAME];
  }

  // Compose the sub-agent's full system prompt: a focused base + agent persona
  // + the structured-output instruction + any (advisory) budget guidance.
  let systemPrompt =
    "You are a focused sub-agent executing one phase of a larger automated workflow.\n" +
    `Working directory: ${cwd}\n` +
    "Use the available tools to complete the task. Be thorough but concise. " +
    "Do not ask questions — make reasonable assumptions and finish the task.";
  if (systemPromptExtra?.trim()) systemPrompt += `\n\n${systemPromptExtra.trim()}`;
  if (schema) systemPrompt += `\n\n${schemaToolPrompt()}`;
  if (budget) {
    let b = "BUDGET LIMITS:";
    if (budget.maxTokens) b += `\n- Maximum ${budget.maxTokens} total tokens`;
    if (budget.maxTurns) b += `\n- Maximum ${budget.maxTurns} turns`;
    if (budget.maxCost) b += `\n- Maximum $${budget.maxCost} cost`;
    systemPrompt += `\n\n${b}`;
  }

  if (signal?.aborted) {
    return {
      exitCode: 1,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      stopReason: "aborted",
      errorMessage: "Aborted before start",
    };
  }

  // Gate on the global semaphore so concurrent workflows can't spawn an
  // unbounded number of sub-agent sessions at once.
  await acquireAgentSlot();

  let session: any;
  let timedOut = false;
  try {
    const resolvedModel = model ? resolveModelPattern(model) : undefined;
    const created = await createAgentSession({
      cwd,
      model: resolvedModel ?? defaultModel,
      thinkingLevel: thinking ?? "off",
      tools: activeTools,
      customTools: customTools.length > 0 ? customTools : undefined,
      authStorage: getAuthStorage(),
      modelRegistry: getModelRegistry(),
      resourceLoader: isolatedResourceLoader(systemPrompt),
      sessionManager: SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    });
    session = created.session;

    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timedOut = true;
      void session.abort();
    }, timeout);
    const onSignalAbort = () => void session.abort();
    if (signal) signal.addEventListener("abort", onSignalAbort, { once: true });

    try {
      await session.prompt(prompt);
    } finally {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) signal.removeEventListener("abort", onSignalAbort);
    }

    const messages = session.messages as Message[];
    const usage = collectUsage(messages);
    const { stopReason, errorMessage } = lastAssistantStatus(messages);

    if (timedOut) {
      return { exitCode: 1, messages, stderr: "", usage, stopReason: "timeout", errorMessage: "Phase timed out" };
    }
    if (signal?.aborted) {
      return { exitCode: 1, messages, stderr: "", usage, stopReason: "aborted", errorMessage: "Phase cancelled" };
    }
    const exitCode = stopReason === "error" || stopReason === "aborted" ? 1 : 0;
    return { exitCode, messages, stderr: "", usage, stopReason, errorMessage, structured: capturedStructured };
  } catch (err: any) {
    const messages = (session?.messages ?? []) as Message[];
    return {
      exitCode: 1,
      messages,
      stderr: "",
      usage: collectUsage(messages),
      stopReason: "error",
      errorMessage: err?.message ?? String(err),
    };
  } finally {
    try {
      session?.dispose();
    } catch {
      /* ignore */
    }
    releaseAgentSlot();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Imperative Runtime
//
// A workflow is an async function the author writes; the engine injects the
// primitives (agent / parallel / pipeline / phase / log) and ALL control flow
// (loops, conditionals, transforms) lives in the author's own JS. Each agent()
// call runs as one isolated sub-agent (runSubagent) and is recorded as a step in
// the live WorkflowRunState, so /workflows, the run store, and RPC readers see
// progress exactly as the declarative engine did.
// ═══════════════════════════════════════════════════════════════════════════

type WorkflowRunCallback = (state: WorkflowRunState) => void;

/**
 * Owns the live WorkflowRunState and is the ONLY thing that mutates it.
 * `phase(title)` opens a named group; each agent() call is one step (a
 * PhaseResult) keyed uniquely and shown under the current group. Unlabeled steps
 * auto-number within their group (`<group>/agent-N`) so progress is never empty
 * mid-run. Inline JS between agent() calls intentionally produces no step.
 */
class ProgressRecorder {
  readonly state: WorkflowRunState;
  private readonly onProgress: WorkflowRunCallback;
  private group = "";
  private stepSeq = 0;
  private readonly usedKeys = new Set<string>();

  constructor(state: WorkflowRunState, onProgress: WorkflowRunCallback) {
    this.state = state;
    this.onProgress = onProgress;
  }

  private emit(): void {
    this.onProgress(this.state);
  }

  /** Open a progress group; subsequent agent() steps display under it. */
  setPhase(title: string): void {
    this.group = title;
    this.state.currentPhase = title;
    this.emit();
  }

  /** Append a narrator line (ephemeral; shown in /workflows, not persisted). */
  log(msg: string): void {
    (this.state.logs ??= []).push(msg);
    this.emit();
  }

  /** Reserve a unique key and open a running step. Returns the key. */
  startStep(label?: string): string {
    this.stepSeq += 1;
    const base = label?.trim() || `${this.group || "step"}/agent-${this.stepSeq}`;
    let key = base;
    let n = 2;
    while (this.usedKeys.has(key)) key = `${base} (${n++})`;
    this.usedKeys.add(key);
    this.state.phases[key] = {
      phaseName: this.group && label ? `${this.group} · ${label}` : base,
      status: "running",
      attempts: 1,
    };
    this.emit();
    return key;
  }

  /** Record the current attempt number on a running step (for retry display). */
  setAttempt(key: string, attempt: number): void {
    const pr = this.state.phases[key];
    if (pr) {
      pr.attempts = attempt;
      this.emit();
    }
  }

  // finishStep/failStep mutate the entry startStep() already created (it always
  // runs first), preserving its phaseName (and finishStep its attempts).
  finishStep(key: string, output: any, usage: Usage, duration: number): void {
    const pr = this.state.phases[key];
    if (!pr) return;
    pr.status = "completed";
    pr.output = output;
    pr.usage = usage;
    pr.duration = duration;
    this.emit();
  }

  failStep(key: string, error: string, usage: Usage, duration: number, attempts: number): void {
    const pr = this.state.phases[key];
    if (!pr) return;
    pr.status = "failed";
    pr.error = error;
    pr.usage = usage;
    pr.duration = duration;
    pr.attempts = attempts;
    this.emit();
  }
}

/**
 * Build the run-bound `agent()` primitive. Wraps runSubagent with persona/option
 * resolution (per-call options override the named agent's defaults — same
 * precedence as the old executeSinglePhase), schema normalization, an internal
 * retry loop (a schema mismatch is a retryable failure), structured extraction,
 * and progress recording. Returns the text (no schema) or the validated object
 * (with schema); throws after exhausting retries so native try/catch works.
 */
function makeAgentPrimitive(
  cwd: string,
  agents: Map<string, AgentConfig>,
  runBudget: BudgetConfig | undefined,
  signal: AbortSignal | undefined,
  recorder: ProgressRecorder,
): (prompt: string, opts?: AgentOptions) => Promise<any> {
  return async function agent(prompt: string, opts: AgentOptions = {}): Promise<any> {
    const key = recorder.startStep(opts.label);
    const started = Date.now();
    const agg = emptyUsage();
    const fail = (msg: string, attempts: number): never => {
      recorder.failStep(key, msg, agg, Date.now() - started, attempts);
      throw new Error(msg);
    };

    // Resolve the named persona into defaults; per-call options win.
    let persona: AgentConfig | undefined;
    if (opts.agent) {
      persona = agents.get(opts.agent);
      if (!persona) {
        const available = Array.from(agents.keys()).map((n) => `"${n}"`).join(", ") || "none";
        fail(`Unknown agent "${opts.agent}". Available: ${available}.`, 1);
      }
    }
    const model = opts.model ?? persona?.model;
    const tools = opts.tools ?? persona?.tools;
    const thinking = opts.thinking ?? persona?.thinking;
    const schema = opts.schema ? normalizeSchema(opts.schema) : undefined;
    const systemPromptExtra =
      [persona?.systemPrompt, opts.systemPrompt].filter((s) => s && s.trim()).join("\n\n") ||
      undefined;
    const budget: BudgetConfig | undefined =
      runBudget || opts.budget ? { ...runBudget, ...opts.budget } : undefined;
    const timeout = opts.timeout ?? PHASE_TIMEOUT_MS;
    const maxAttempts = 1 + (opts.retries ?? 0);
    const retryDelay = opts.retryDelay ?? DEFAULT_RETRY_DELAY;

    let lastError: Error | undefined;
    let attemptsMade = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attemptsMade = attempt;
      if (signal?.aborted) fail("Aborted", attempt);
      if (attempt > 1) recorder.setAttempt(key, attempt);
      try {
        const result = await runSubagent(
          cwd,
          prompt,
          model,
          tools,
          systemPromptExtra,
          schema,
          budget,
          thinking,
          timeout,
          signal,
        );
        addUsage(agg, result.usage);
        if (result.exitCode !== 0 || result.stopReason === "error") {
          throw new Error(
            result.errorMessage || result.stderr || `Sub-agent exited with code ${result.exitCode}`,
          );
        }
        const finalText = getFinalAssistantText(result.messages);
        let output: any;
        if (schema) {
          const parsed = result.structured ?? extractJsonFromText(finalText);
          if (!parsed) {
            throw new Error(
              `Sub-agent did not produce valid structured output. Response: ${finalText.slice(0, 500)}`,
            );
          }
          validateSchema(schema, parsed, opts.label ?? key);
          output = parsed;
        } else {
          output = finalText;
        }
        recorder.finishStep(key, output, agg, Date.now() - started);
        return output;
      } catch (err: any) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (signal?.aborted) break; // don't retry a cancelled run
        if (attempt < maxAttempts) await sleep(retryDelay);
      }
    }
    return fail(lastError?.message ?? "Agent failed", attemptsMade);
  };
}

/**
 * `parallel(thunks)` — run thunks concurrently behind a worker pool (dispatch
 * capped at MAX_CONCURRENCY; the global semaphore in runSubagent still bounds
 * total sub-agents). Barrier: awaits all. Results in INPUT order. A thunk that
 * throws yields `null` in its slot (the failure stays visible as that agent's
 * failed step), so one bad task never aborts the batch — filter with
 * `.filter(Boolean)`.
 */
async function runParallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>> {
  const results: Array<T | null> = new Array(thunks.length).fill(null);
  let next = 0;
  const workers = new Array(Math.min(MAX_CONCURRENCY, thunks.length)).fill(null).map(async () => {
    while (true) {
      const idx = next++;
      if (idx >= thunks.length) return;
      try {
        results[idx] = await thunks[idx]();
      } catch {
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * `pipeline(items, ...stages)` — each item flows through ALL stages independently
 * (stage k gets stage k-1's output for that item), no barrier between items, so
 * one item can be in stage 3 while another is still in stage 1. Dispatch capped
 * at MAX_CONCURRENCY items in flight. Results in input order; an item whose chain
 * throws yields `null` (others continue).
 */
async function runPipeline(
  items: any[],
  ...stages: Array<(item: any, index: number) => any | Promise<any>>
): Promise<any[]> {
  const results: any[] = new Array(items.length).fill(null);
  let next = 0;
  const workers = new Array(Math.min(MAX_CONCURRENCY, items.length)).fill(null).map(async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      try {
        let acc: any = items[idx];
        for (const stage of stages) acc = await stage(acc, idx);
        results[idx] = acc;
      } catch {
        results[idx] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Engine
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run an imperative workflow: build the live state + a ProgressRecorder, assemble
 * the runtime (the injected primitives + args/cwd/budget), and call the author's
 * function EXACTLY ONCE. Its return value is the run's deliverable (state.result;
 * falls back to the last completed step's output if the body returns nothing). A
 * thrown error fails the run with the partial steps preserved — same terminal
 * semantics as the declarative engine.
 */
async function runImperativeWorkflow(
  loaded: LoadedWorkflow,
  cwd: string,
  onProgress: WorkflowRunCallback,
  signal: AbortSignal | undefined,
  runId?: string,
  input = "",
): Promise<WorkflowRunState> {
  const state: WorkflowRunState = {
    id: runId ?? generateId(),
    name: loaded.name,
    status: "running",
    phases: {},
    startTime: Date.now(),
  };
  const recorder = new ProgressRecorder(state, onProgress);
  const agents = discoverAgents(cwd);
  const runBudget: BudgetConfig | undefined = undefined; // reserved for a future run-level budget

  const runtime: WorkflowRuntime = {
    agent: makeAgentPrimitive(cwd, agents, runBudget, signal, recorder),
    parallel: runParallel,
    pipeline: runPipeline,
    phase: (title: string) => recorder.setPhase(title),
    log: (msg: string) => recorder.log(msg),
    args: input,
    cwd,
    budget: runBudget,
  };

  try {
    const returned = await loaded.fn(runtime);
    // The return value is the deliverable; if the body returned nothing, fall back
    // to the last completed step's output (resolveDeliverable owns that rule).
    // Resolve BEFORE checking the abort signal so a run that finished just as it
    // was cancelled doesn't silently lose its output.
    state.result = returned !== undefined ? returned : resolveDeliverable(state);
    state.status = signal?.aborted ? "cancelled" : "completed";
  } catch (err: any) {
    state.status = signal?.aborted ? "cancelled" : "failed";
    if (state.status === "failed") state.error = err?.message ?? String(err);
  }

  state.endTime = Date.now();
  state.currentPhase = undefined;
  onProgress(state);
  return state;
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Registry (in-memory state)
// ═══════════════════════════════════════════════════════════════════════════

interface WorkflowRegistryEntry {
  run: WorkflowRunState;
  definition: LoadedWorkflow;
  abortController?: AbortController;
}

const registry = new Map<string, WorkflowRegistryEntry>();

/** Latest ExtensionContext seen via events, so background callbacks (which run
 *  with no ctx of their own) can still reach ctx.ui for notifications. */
let currentCtx: ExtensionContext | null = null;

/** The ExtensionAPI, captured at load, so background callbacks can emit a
 *  structured, non-waking completion marker (pi.sendMessage, deliverAs:
 *  "nextTurn") when a workflow finishes — without waking the agent. */
let extensionApi: ExtensionAPI | null = null;

/** The cwd used to resolve the on-disk run store. Set on session_start /
 *  turn_start; falls back to process.cwd() before the first event so the
 *  synchronous store reads in getRecentRuns/findRun always have a base dir. */
let runStoreCwd: string = process.cwd();

/** Recent runs, newest first, MERGING the in-memory registry with the on-disk
 *  run store. The registry is authoritative for live status (a run executing in
 *  THIS process); on-disk runs cover reloaded / other-session / other-process
 *  runs. Registry wins on id collision. This is what makes /workflows,
 *  /workflow-result, and get_workflow_result work after /reload. */
function getRecentRuns(limit = 5): WorkflowRunState[] {
  const byId = new Map<string, WorkflowRunState>();
  for (const p of listRunFiles(runStoreDir(runStoreCwd))) byId.set(p.id, fromPersistedRun(p));
  for (const e of registry.values()) byId.set(e.run.id, e.run);
  return Array.from(byId.values())
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, limit);
}

/** Find a run by name or run id. Defaults to the most recent run.
 *  An explicit id resolves directly (registry then disk) so even an old run
 *  that has aged out of the recent-runs cache still loads. When matching by
 *  name, prefers the most recent run with that name. */
function findRun(nameOrId?: string): WorkflowRunState | undefined {
  if (nameOrId) {
    const key = nameOrId.trim();
    const reg = registry.get(key);
    if (reg) return reg.run;
    const onDisk = readRunFile(key, runStoreDir(runStoreCwd));
    if (onDisk) return fromPersistedRun(onDisk);
  }
  const runs = getRecentRuns(100);
  if (!nameOrId) return runs[0];
  const key = nameOrId.trim();
  return runs.find((r) => r.id === key) ?? runs.find((r) => r.name === key);
}

// ═══════════════════════════════════════════════════════════════════════════
// Run Store (one JSON file per run, persisted to disk)
// ═══════════════════════════════════════════════════════════════════════════
//
// Runs are persisted so they (a) survive /reload, (b) are addressable by id,
// and (c) are readable by an EXTERNAL process — a frontend or orchestrator
// driving pi over RPC — which cannot see pi's in-memory registry. The store is
// the lossless, structured, pollable channel for that integration. Files are
// written atomically (write *.json.tmp then rename) so a reader never observes
// a half-written file. See README "Programmatic / RPC integration".

// v2 adds `result` (the workflow function's return value / deliverable).
const RUN_SCHEMA_VERSION = 2;
const RUN_FILE_EXT = ".json";
const RUN_TMP_SUFFIX = ".json.tmp";
/** Coalesce intermediate progress writes to at most one per this interval. */
const RUN_WRITE_THROTTLE_MS = 1500;
/** Retention: keep at most this many of the newest runs. */
const RUN_RETENTION_MAX = 50;
/** Retention: drop runs older than this. */
const RUN_RETENTION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Never prune a run touched more recently than this (avoids racing a sibling
 *  process's brand-new run before its first flush). */
const RUN_PRUNE_MIN_AGE_MS = 60_000;

/** Provenance threaded into each persisted run. */
interface RunMeta {
  input: string;
  cwd: string;
  sessionId?: string;
}

/**
 * THE single source of truth for where run files live. Resolution order:
 *   1. $PI_WORKFLOWS_RUN_DIR (absolute path) — for a frontend / tests / OS-temp.
 *   2. <nearest .pi>/workflow-runs  (sibling of .pi/workflows — project-scoped).
 *   3. <cwd>/.pi/workflow-runs      (fallback when no .pi/workflows exists yet).
 * Project-scoped (not session-scoped) so runs stay visible across /reload,
 * /new, /resume, and to external readers; sessionId is recorded INSIDE each
 * file for optional per-session filtering.
 */
function runStoreDir(cwd: string): string {
  const override = process.env.PI_WORKFLOWS_RUN_DIR;
  if (override && override.trim()) return override.trim();
  const wfDir = findWorkflowsDir(cwd); // .../.pi/workflows
  const piDir = wfDir ? path.dirname(wfDir) : path.join(cwd, ".pi");
  return path.join(piDir, "workflow-runs");
}

/** Absolute path to a run's JSON file. */
function runFilePath(id: string, cwd: string): string {
  return path.join(runStoreDir(cwd), `${id}${RUN_FILE_EXT}`);
}

/** Ensure the run-store directory exists; returns it. Idempotent. */
function ensureRunStoreDir(cwd: string): string {
  const dir = runStoreDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Build the on-disk shape from a live run + provenance. */
function toPersistedRun(state: WorkflowRunState, meta: RunMeta): PersistedRun {
  return {
    schemaVersion: RUN_SCHEMA_VERSION,
    id: state.id,
    name: state.name,
    status: state.status,
    phases: state.phases,
    currentPhase: state.currentPhase,
    result: state.result,
    startTime: state.startTime,
    endTime: state.endTime,
    error: state.error,
    input: meta.input,
    cwd: meta.cwd,
    pid: process.pid,
    sessionId: meta.sessionId,
    usage: totalRunUsage(state),
    updatedAt: Date.now(),
  };
}

/** Map a persisted run back to the live WorkflowRunState used everywhere.
 *  "interrupted" (a dead-owner run) maps to "failed" with an explanation. */
function fromPersistedRun(p: PersistedRun): WorkflowRunState {
  const interrupted = p.status === "interrupted";
  return {
    id: p.id,
    name: p.name,
    // Inline comparison (not the `interrupted` const) so TS narrows away the
    // "interrupted" variant that WorkflowRunState["status"] doesn't include.
    status: p.status === "interrupted" ? "failed" : p.status,
    phases: p.phases ?? {},
    currentPhase: p.currentPhase,
    result: p.result,
    startTime: p.startTime,
    endTime: p.endTime,
    error: interrupted
      ? (p.error ?? "Interrupted (the process running this workflow exited).")
      : p.error,
  };
}

/** Atomically persist a PersistedRun: write <id>.json.tmp then rename to
 *  <id>.json. rename(2) is atomic when src and dst share a filesystem — they
 *  always do here (same directory) — so an external reader sees either the old
 *  complete file or the new one, never a torn write. Persistence must never
 *  break a run: on any failure, warn and continue in-memory. */
function writePersistedRun(p: PersistedRun, cwd: string): void {
  try {
    const dir = ensureRunStoreDir(cwd);
    const finalPath = path.join(dir, `${p.id}${RUN_FILE_EXT}`);
    const tmpPath = path.join(dir, `${p.id}${RUN_TMP_SUFFIX}`);
    fs.writeFileSync(tmpPath, JSON.stringify(p, null, 2));
    fs.renameSync(tmpPath, finalPath);
  } catch (err: any) {
    currentCtx?.ui.notify(
      `Workflow run could not be persisted: ${err?.message ?? err}`,
      "warning",
    );
  }
}

/** Persist a live run (convenience over writePersistedRun). */
function writeRunFile(state: WorkflowRunState, meta: RunMeta): void {
  writePersistedRun(toPersistedRun(state, meta), meta.cwd);
}

/** Read one run file by id. Returns undefined if missing / corrupt. */
function readRunFile(id: string, dir: string): PersistedRun | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, `${id}${RUN_FILE_EXT}`), "utf8"),
    ) as PersistedRun;
    return parsed && typeof parsed.id === "string" ? parsed : undefined;
  } catch {
    return undefined; // missing, mid-write (shouldn't happen w/ atomic), or bad JSON
  }
}

/** All run files in the store, newest first. Skips *.json.tmp and corrupt ones. */
function listRunFiles(dir: string): PersistedRun[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return []; // dir doesn't exist yet
  }
  const runs: PersistedRun[] = [];
  for (const n of names) {
    // ".json.tmp" ends with ".tmp", not ".json", so this also excludes temps.
    if (!n.endsWith(RUN_FILE_EXT)) continue;
    const p = readRunFile(n.slice(0, -RUN_FILE_EXT.length), dir);
    if (p) runs.push(p);
  }
  runs.sort((a, b) => b.startTime - a.startTime);
  return runs;
}

/** Last write time per run id, for throttling intermediate progress writes. */
const lastRunWrite = new Map<string, number>();
const pendingRunWrite = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Persist a run, throttled. A terminal status (completed/failed/cancelled)
 * forces an immediate, guaranteed write and clears any pending timer, so the
 * final file is always complete and current. Intermediate progress is coalesced
 * to at most one write per RUN_WRITE_THROTTLE_MS; the trailing write serializes
 * the latest state (runImperativeWorkflow mutates one state object in place).
 */
function scheduleRunWrite(state: WorkflowRunState, meta: RunMeta): void {
  const terminal = state.status !== "running";
  const now = Date.now();
  const last = lastRunWrite.get(state.id) ?? 0;

  const flush = () => {
    const t = pendingRunWrite.get(state.id);
    if (t) {
      clearTimeout(t);
      pendingRunWrite.delete(state.id);
    }
    lastRunWrite.set(state.id, Date.now());
    writeRunFile(state, meta);
  };

  if (terminal || now - last >= RUN_WRITE_THROTTLE_MS) {
    flush();
    if (terminal) lastRunWrite.delete(state.id); // run is done; clean up
    return;
  }
  if (!pendingRunWrite.has(state.id)) {
    pendingRunWrite.set(state.id, setTimeout(flush, RUN_WRITE_THROTTLE_MS - (now - last)));
  }
}

/** Whether a process is alive. signal 0 only probes existence; EPERM means it
 *  exists but isn't ours. */
function isProcessAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
}

/**
 * On startup / reload, reconcile the on-disk store: any run still marked
 * "running" whose owning process is gone is rewritten as "interrupted", since
 * its in-process executor no longer exists and can never complete it.
 *
 * Conservative rule: only a dead PID triggers this. A reloaded-but-alive
 * process (same PID) leaves its run "running"; that process's own executor
 * keeps writing and its terminal write reconciles the file.
 */
function rehydrateRuns(cwd: string): void {
  for (const p of listRunFiles(runStoreDir(cwd))) {
    if (p.status !== "running" || isProcessAlive(p.pid)) continue;
    writePersistedRun(
      {
        ...p,
        status: "interrupted",
        endTime: p.endTime ?? Date.now(),
        error: p.error ?? "Interrupted (the process running this workflow exited).",
        updatedAt: Date.now(),
      },
      cwd,
    );
  }
}

/**
 * Retention: delete runs older than RUN_RETENTION_MAX_AGE_MS and, of what
 * remains, keep only the newest RUN_RETENTION_MAX. Never prunes a running run
 * with a live owner or a very recently touched run. Sweeps orphaned *.json.tmp.
 * Notifies what was pruned (no silent deletion).
 */
function pruneRunStore(cwd: string): void {
  const dir = runStoreDir(cwd);
  let entries: PersistedRun[];
  try {
    entries = listRunFiles(dir); // newest first
  } catch {
    return;
  }

  // Sweep orphaned temp files (a crash between write and rename).
  try {
    for (const n of fs.readdirSync(dir)) {
      if (n.endsWith(RUN_TMP_SUFFIX)) {
        try {
          fs.unlinkSync(path.join(dir, n));
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* dir missing */
  }

  const now = Date.now();
  const protect = (p: PersistedRun) =>
    (p.status === "running" && isProcessAlive(p.pid)) ||
    now - (p.updatedAt ?? p.startTime) < RUN_PRUNE_MIN_AGE_MS;

  const tooOld = entries.filter(
    (p) => !protect(p) && now - (p.endTime ?? p.startTime) > RUN_RETENTION_MAX_AGE_MS,
  );
  const survivors = entries.filter((p) => !tooOld.includes(p)); // still newest-first
  const overflow = survivors.filter((p) => !protect(p)).slice(RUN_RETENTION_MAX);

  let deleted = 0;
  for (const p of [...tooOld, ...overflow]) {
    try {
      fs.unlinkSync(path.join(dir, `${p.id}${RUN_FILE_EXT}`));
      deleted++;
    } catch {
      /* ignore (ENOENT from a concurrent prune is fine) */
    }
  }
  if (deleted > 0) {
    currentCtx?.ui.notify(`Pruned ${deleted} old workflow run file(s).`, "info");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow File Loading
// ═══════════════════════════════════════════════════════════════════════════

/** Resolve the workflow function from a module's default export, tolerating
 *  jiti/CJS interop that can double-wrap it (`mod.default.default`). */
function resolveWorkflowFn(mod: Record<string, any>): WorkflowFn | undefined {
  const d = mod?.default;
  if (typeof d === "function") return d as WorkflowFn;
  if (d && typeof d.default === "function") return d.default as WorkflowFn;
  return undefined;
}

/** Walk up from cwd to find a `.pi/workflows` directory (mirrors how agents are
 *  discovered). Returns the first match, or null. */
function findWorkflowsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".pi", "workflows");
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch {
      /* not here, walk up */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every `*.{js,ts}` in the nearest `.pi/workflows` directory. */
function collectWorkflowFiles(cwd: string): string[] {
  const files: string[] = [];
  const dir = findWorkflowsDir(cwd);
  if (!dir) return files;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      if (entry.name.endsWith(".js") || entry.name.endsWith(".ts")) {
        files.push(path.join(dir, entry.name));
      }
    }
  } catch {
    /* ignore unreadable dir */
  }
  return files;
}

/** Heuristic: does this module look like a RETIRED declarative workflow — a
 *  `{ name, phases: [ {…}, … ] }` object exported as default or by name? Used
 *  ONLY to turn a silent "no workflow here" into a precise migration error; the
 *  declarative format is not supported. (The new `meta.phases` is a `string[]`
 *  display hint, so we require phases of OBJECTS to avoid false positives.) */
function looksDeclarative(mod: Record<string, any>): boolean {
  const isDecl = (v: any): boolean =>
    !!v &&
    typeof v === "object" &&
    typeof v.name === "string" &&
    Array.isArray(v.phases) &&
    v.phases.some((p: any) => p && typeof p === "object");
  return isDecl(mod.default) || Object.values(mod).some(isDecl);
}

/** Pull the workflow out of an imported module: a default-export function plus
 *  an exported `meta` (name / description / phases). `meta` may live on the
 *  module or on the default export; the filename is the last-resort name.
 *  Returns whether a workflow was found, so the caller can surface a clear error
 *  for a file that loaded but exported no workflow (rather than dropping it). */
function extractWorkflows(
  mod: Record<string, any>,
  file: string,
  into: Map<string, LoadedWorkflow>,
): boolean {
  const fn = resolveWorkflowFn(mod);
  if (!fn) return false;
  const meta = (mod.meta ?? (mod.default as any)?.meta ?? {}) as Partial<WorkflowMeta>;
  const name =
    typeof meta.name === "string" && meta.name.trim()
      ? meta.name.trim()
      : path.basename(file, path.extname(file));
  into.set(name, {
    name,
    description: typeof meta.description === "string" ? meta.description : undefined,
    phases: Array.isArray(meta.phases) ? meta.phases : undefined,
    fn,
  });
  return true;
}

/**
 * Import a workflow file such that **edits are always picked up** — no `/reload`,
 * no restart.
 *
 * Why this is needed: a plain `import(file)` is cached by Node's ESM registry
 * (and pi's jiti loader), keyed by path, and that cache is never evicted
 * in-process — re-importing the same path returns stale code even after
 * `/reload`. We sidestep it by loading from a **unique sibling temp file** each
 * time: a fresh path means a guaranteed cache miss, so the latest source runs.
 *
 * The temp is written next to the original (so any relative imports still
 * resolve) with a `.mjs`/`.mts` extension that workflow discovery ignores, and
 * removed immediately after import.
 */
async function importWorkflowFile(file: string): Promise<Record<string, any>> {
  const isTs = file.endsWith(".ts");
  const tmp = path.join(
    path.dirname(file),
    `.piwf-${Date.now()}-${Math.random().toString(36).slice(2)}.${isTs ? "mts" : "mjs"}`,
  );
  fs.writeFileSync(tmp, fs.readFileSync(file, "utf8"));
  try {
    return (await import(tmp)) as Record<string, any>;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

async function discoverWorkflows(cwd: string): Promise<Map<string, LoadedWorkflow>> {
  const workflows = new Map<string, LoadedWorkflow>();
  const errors: Array<{ file: string; error: string }> = [];

  for (const file of collectWorkflowFiles(cwd)) {
    try {
      const mod = await importWorkflowFile(file);
      // A file that imports cleanly but exports no workflow used to vanish with
      // no feedback — looking like "no workflows configured" rather than "this
      // file is in the wrong format". Surface a precise, actionable error.
      if (!extractWorkflows(mod, file, workflows)) {
        errors.push({
          file,
          error: looksDeclarative(mod)
            ? "uses the retired declarative format ({ name, phases: [...] }). Rewrite as `export default async function (rt) {…}` + `export const meta = { name }` — see .pi/skills/workflows/SKILL.md."
            : "exported no workflow — expected `export default async function (rt) {…}` (plus `export const meta = { name }`).",
        });
      }
    } catch (err: any) {
      // Surface the failure instead of silently swallowing it — a single broken
      // file used to make ALL workflows vanish with no explanation.
      errors.push({ file, error: err?.message ?? String(err) });
    }
  }

  workflowLoadErrors = errors;
  // Cache names for synchronous argument autocompletion (/workflow <name>).
  cachedWorkflowNames = Array.from(workflows.keys());
  return workflows;
}

/** Names from the most recent discovery — used for command autocomplete,
 *  which must be synchronous and so cannot await discoverWorkflows. */
let cachedWorkflowNames: string[] = [];

/** Per-file load failures from the most recent discovery, surfaced to the user
 *  so a broken workflow file is diagnosable rather than silently missing. */
let workflowLoadErrors: Array<{ file: string; error: string }> = [];

/** A short, human-readable summary of load errors (or "" if none). */
function loadErrorsText(): string {
  if (workflowLoadErrors.length === 0) return "";
  const lines = workflowLoadErrors.map(
    (e) => `  • ${path.basename(e.file)}: ${e.error.split("\n")[0]}`,
  );
  return `\n\n${workflowLoadErrors.length} workflow file(s) failed to load:\n${lines.join("\n")}`;
}

/** Register a run, drive it to completion SYNCHRONOUSLY (awaited), and persist it
 *  — the shared core behind the `run_workflow` wait path, `/workflow --wait` over
 *  RPC, and the `--run-workflow` headless flag. Keeps the registry in sync and
 *  writes the run store on every progress tick (throttled) plus a final flush;
 *  `onProgress` is an optional extra hook (e.g. to stream to a tool's onUpdate).
 *  Returns the run id and the terminal state. */
async function runRegistered(
  def: LoadedWorkflow,
  cwd: string,
  input: string,
  sessionId: string | undefined,
  abortController: AbortController,
  onProgress?: (state: WorkflowRunState) => void,
): Promise<{ runId: string; state: WorkflowRunState }> {
  const runId = generateId();
  const meta: RunMeta = { input, cwd, sessionId };
  registry.set(runId, {
    run: { id: runId, name: def.name, status: "running", phases: {}, startTime: Date.now() },
    definition: def,
    abortController,
  });
  scheduleRunWrite(registry.get(runId)!.run, meta);
  const state = await runImperativeWorkflow(
    def,
    cwd,
    (u) => {
      const e = registry.get(runId);
      if (e) e.run = u;
      scheduleRunWrite(u, meta);
      onProgress?.(u);
    },
    abortController.signal,
    runId,
    input,
  );
  writeRunFile(state, meta); // synchronous force-write of the terminal state
  return { runId, state };
}

/** Start a workflow in the background: register it, persist it to the run store
 *  (so /workflows, /workflow-result, get_workflow_result, and EXTERNAL readers
 *  can track it), and run it detached.
 *
 *  On completion it does NOT wake pi's own agent. The run file is the
 *  authoritative completion signal; a structured, non-waking marker
 *  (deliverAs:"nextTurn") additionally carries the run id + result file path for
 *  any RPC/orchestrator consumer reading the message stream. A passive toast
 *  gives interactive users visual feedback without consuming context. */
function startBackgroundRun(
  def: LoadedWorkflow,
  cwd: string,
  input = "",
  sessionId?: string,
  // When false, suppress the completion toast + non-waking marker — used when the
  // caller is already showing the run live (e.g. `/workflow … --wait`). The run is
  // still registered and persisted exactly the same.
  announce = true,
): string {
  const abortController = new AbortController();
  const runId = generateId();
  const meta: RunMeta = { input, cwd, sessionId };
  const runState: WorkflowRunState = {
    id: runId,
    name: def.name,
    status: "running",
    phases: {},
    startTime: Date.now(),
  };
  registry.set(runId, { run: runState, definition: def, abortController });
  scheduleRunWrite(runState, meta); // persist the "running" run immediately

  // Announce terminal state exactly once. onProgress can be called repeatedly.
  let announced = false;

  /**
   * Structured, NON-waking completion marker. deliverAs:"nextTurn" never
   * triggers a turn (so pi's own agent is not woken), yet the message still
   * reaches an RPC client via the message stream / get_messages, carrying the
   * run id and the path to the full result file.
   */
  const emitRunMarker = (status: "completed" | "failed" | "cancelled", content: string) => {
    extensionApi?.sendMessage(
      {
        customType: "workflow-status",
        content,
        display: false,
        details: { runId, name: def.name, status, file: runFilePath(runId, cwd), dir: runStoreDir(cwd) },
      },
      { deliverAs: "nextTurn" },
    );
  };

  runImperativeWorkflow(
    def,
    cwd,
    (updated) => {
      const entry = registry.get(runId);
      if (entry) entry.run = updated;
      scheduleRunWrite(updated, meta); // throttled; force-flushes on terminal status

      if (!announce || announced) return;
      if (updated.status === "completed") {
        announced = true;
        currentCtx?.ui.notify(
          `Workflow "${def.name}" complete (run ${runId}). /workflow-result to view.`,
          "info",
        );
        emitRunMarker("completed", `Workflow "${def.name}" (run ${runId}) completed.`);
      } else if (updated.status === "failed") {
        announced = true;
        currentCtx?.ui.notify(
          `Workflow "${def.name}" failed (run ${runId}): ${updated.error || "Unknown error"}`,
          "error",
        );
        emitRunMarker(
          "failed",
          `Workflow "${def.name}" (run ${runId}) failed: ${updated.error || "Unknown error"}`,
        );
      } else if (updated.status === "cancelled") {
        announced = true;
        currentCtx?.ui.notify(`Workflow "${def.name}" was cancelled (run ${runId}).`, "warning");
        emitRunMarker("cancelled", `Workflow "${def.name}" (run ${runId}) was cancelled.`);
      }
    },
    abortController.signal,
    runId,
    input,
  ).then(
    // Guarantee a final on-disk write even if some future early-return path
    // skips a terminal onProgress. Redundant with scheduleRunWrite's force-flush
    // in the normal case; harmless (atomic).
    (final) => writeRunFile(final, meta),
    () => {
      const e = registry.get(runId);
      if (e) writeRunFile(e.run, meta);
    },
  );

  return runId;
}

/** The run's deliverable: the workflow function's return value, or — for older
 *  runs persisted before `result` existed — the last completed step's output. */
function resolveDeliverable(state: WorkflowRunState): any {
  if (state.result !== undefined) return state.result;
  const completed = Object.values(state.phases).filter(
    (pr) => pr.status === "completed" && pr.output != null,
  );
  return completed.length ? completed[completed.length - 1].output : undefined;
}

/** Format a completed run's deliverable into a readable summary, closing with the
 *  token usage that stayed out of the main context. The deliverable (the
 *  function's return value) is kept in full; intermediate steps are visible in
 *  /workflows progress and so are not re-dumped here. */
function buildResultText(name: string, state: WorkflowRunState): string {
  const deliverable = resolveDeliverable(state);
  const body =
    deliverable == null
      ? "Workflow completed with no output."
      : typeof deliverable === "string"
        ? deliverable
        : JSON.stringify(deliverable, null, 2);
  const usageStr = formatUsage(totalRunUsage(state));
  const usageLine = usageStr
    ? `\n\n_Sub-agents used ${usageStr} — kept out of the main context window._`
    : "";
  return `Workflow "${name}" completed successfully.\n\n${body}${usageLine}`;
}

/** Build full (untruncated), styled lines describing a run's result — for the
 *  human-facing /workflow-result viewer (no context cost, so nothing is clipped). */
function buildResultLines(state: WorkflowRunState, theme: ThemeLike): string[] {
  const lines: string[] = [];
  const statusColor =
    state.status === "completed" ? "success" : state.status === "failed" ? "error" : "warning";
  lines.push(
    `${theme.bold(state.name)} ${theme.fg(statusColor, `[${state.status}]`)} ${theme.fg("dim", formatUsage(totalRunUsage(state)))}`,
  );
  if (state.error) lines.push(theme.fg("error", `Error: ${state.error}`));
  lines.push("");

  // The deliverable (return value), in full.
  const deliverable = resolveDeliverable(state);
  if (deliverable != null) {
    lines.push(theme.fg("accent", theme.bold("### result")));
    const text =
      typeof deliverable === "string" ? deliverable : JSON.stringify(deliverable, null, 2);
    for (const l of text.split("\n")) lines.push(theme.fg("muted", l));
    lines.push("");
  }

  // A compact trail of the steps that ran (their full outputs stay out of the
  // way; they were visible live in /workflows).
  const steps = Object.values(state.phases);
  if (steps.length > 0) {
    lines.push(theme.fg("dim", "Steps:"));
    for (const pr of steps) {
      const icon =
        pr.status === "completed" ? "✓" :
        pr.status === "failed" ? "✗" :
        pr.status === "skipped" ? "→" : "○";
      lines.push(theme.fg("dim", `  ${icon} ${pr.phaseName}`) + (pr.error ? theme.fg("error", ` — ${pr.error.split("\n")[0]}`) : ""));
    }
    lines.push("");
  }
  return lines;
}

// ── Scrollable result viewer (shared by /workflow-result and /workflow --wait) ──

/** Visible content rows in the scrollable result viewer. */
const RESULT_PAGE = 22;

/** Wrap a run's full result (buildResultLines) to `width`, preserving blank-line
 *  spacing. Pure + width-dependent, so callers cache it per (run, width) instead
 *  of re-wrapping on every repaint. */
function wrapResultLines(state: WorkflowRunState, theme: ThemeLike, width: number): string[] {
  const wrapped: string[] = [];
  for (const line of buildResultLines(state, theme)) {
    if (line === "") wrapped.push("");
    else for (const w of wrapTextWithAnsi(line, width)) wrapped.push(w);
  }
  return wrapped;
}

/** New scroll offset for a key event, or null if `data` isn't a scroll key. */
function scrollResultOffset(data: string, offset: number): number | null {
  let next = offset;
  if (matchesKey(data, "down") || matchesKey(data, "j")) next += 1;
  else if (matchesKey(data, "up") || matchesKey(data, "k")) next -= 1;
  else if (matchesKey(data, "space") || matchesKey(data, "pageDown")) next += RESULT_PAGE;
  else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) next -= RESULT_PAGE;
  else return null;
  return next < 0 ? 0 : next;
}

/** Render the bordered, paged result frame from pre-wrapped lines. `offset` must
 *  already be clamped to [0, maxOffset]. */
function renderResultFrame(
  wrapped: string[],
  offset: number,
  width: number,
  theme: ThemeLike,
  title: string,
): string[] {
  const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
  const view = wrapped.slice(offset, offset + RESULT_PAGE);
  const more = wrapped.length > RESULT_PAGE;
  const pos = more
    ? `  ${offset + 1}-${Math.min(offset + RESULT_PAGE, wrapped.length)} / ${wrapped.length}`
    : "";
  const hint = more ? "↑/↓ or space scroll · q/Esc close" : "q/Esc close";
  const out: string[] = [border];
  out.push(theme.fg("accent", theme.bold(` ${title} `)) + theme.fg("dim", pos));
  out.push(border);
  out.push(...view);
  for (let i = view.length; i < RESULT_PAGE; i++) out.push("");
  out.push(theme.fg("dim", `  ${hint}`));
  out.push(border);
  return out.map((l) => truncateToWidth(l, width));
}

// ═══════════════════════════════════════════════════════════════════════════
// TUI Progress Renderer
// ═══════════════════════════════════════════════════════════════════════════

interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

function renderWorkflowProgress(
  runs: WorkflowRunState[],
  width: number,
  theme: ThemeLike,
): string[] {
  const lines: string[] = [];
  const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));

  lines.push(border);
  const title = theme.fg("accent", theme.bold(" Workflows "));
  lines.push(title + theme.fg("borderMuted", "─".repeat(Math.max(0, width - title.length))));
  lines.push("");

  if (runs.length === 0) {
    lines.push(theme.fg("dim", "  No active or recent workflows."));
    lines.push(theme.fg("dim", "  Add a workflow to .pi/workflows/ and use run_workflow to start one."));
    lines.push("");
    lines.push(border);
    return lines.map((line) => truncateToWidth(line, width));
  }

  for (const run of runs) {
    const dur = ((run.endTime ?? Date.now()) - run.startTime) / 1000;
    const durStr = dur < 60 ? `${dur.toFixed(1)}s` : `${(dur / 60).toFixed(1)}m`;

    let icon: string;
    switch (run.status) {
      case "running":
        icon = theme.fg("warning", "●");
        break;
      case "completed":
        icon = theme.fg("success", "✓");
        break;
      case "failed":
        icon = theme.fg("error", "✗");
        break;
      case "cancelled":
        icon = theme.fg("dim", "◼");
        break;
      default:
        icon = theme.fg("dim", "○");
    }

    const usageStr = formatUsage(totalRunUsage(run));
    const usageSuffix = usageStr ? ` ${theme.fg("dim", usageStr)}` : "";
    lines.push(
      `  ${icon} ${theme.fg("dim", run.id)} ${theme.bold(run.name)} ${theme.fg("muted", `[${run.status}]`)} ${theme.fg("dim", durStr)}${usageSuffix}`,
    );

    // Phase progress
    const phaseEntries = Object.entries(run.phases);
    for (const [name, pr] of phaseEntries) {
      let statusIcon: string;
      let statusColor: string;
      switch (pr.status) {
        case "completed":
          statusIcon = theme.fg("success", "✓");
          statusColor = "success";
          break;
        case "running":
          statusIcon = theme.fg("warning", "●");
          statusColor = "warning";
          break;
        case "failed":
          statusIcon = theme.fg("error", "✗");
          statusColor = "error";
          break;
        case "skipped":
          statusIcon = theme.fg("dim", "→");
          statusColor = "dim";
          break;
        default:
          statusIcon = theme.fg("dim", "○");
          statusColor = "dim";
      }
      const att = pr.attempts ? ` (attempt ${pr.attempts})` : "";
      const phaseTime =
        pr.duration
          ? ` ${theme.fg("dim", `${(pr.duration / 1000).toFixed(1)}s`)}`
          : "";
      const phaseUsage = pr.usage ? formatUsage(pr.usage) : "";
      const phaseUsageStr = phaseUsage ? ` ${theme.fg("dim", phaseUsage)}` : "";
      lines.push(
        `    ${statusIcon} ${theme.fg("accent", name)}${theme.fg(statusColor, att)}${phaseTime}${phaseUsageStr}`,
      );
      if (pr.error) {
        lines.push(
          `      ${theme.fg("error", pr.error.split("\n")[0].slice(0, width - 10))}`,
        );
      }
      if (pr.status === "completed" && pr.output && typeof pr.output === "object") {
        // Show a small summary of structured output
        const keys = Object.keys(pr.output).slice(0, 3);
        if (keys.length > 0) {
          for (const k of keys) {
            const val = typeof pr.output[k] === "string"
              ? pr.output[k]
              : JSON.stringify(pr.output[k]);
            const preview = val.length > 60 ? val.slice(0, 57) + "..." : val;
            lines.push(`      ${theme.fg("dim", `${k}:`)} ${theme.fg("muted", preview)}`);
          }
        }
      }
    }

    if (run.error) {
      lines.push(`  ${theme.fg("error", `Error: ${run.error.slice(0, width - 10)}`)}`);
    }

    lines.push("");
  }

  lines.push(theme.fg("dim", "  Press q or Esc to close"));
  lines.push("");
  lines.push(border);
  return lines.map((line) => truncateToWidth(line, width));
}

function renderWorkflowList(
  workflows: Map<string, LoadedWorkflow>,
  width: number,
  theme: ThemeLike,
): string[] {
  const lines: string[] = [];
  const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));

  lines.push(border);
  const title = theme.fg("accent", theme.bold(" Available Workflows "));
  lines.push(title + theme.fg("borderMuted", "─".repeat(Math.max(0, width - title.length))));
  lines.push("");

  if (workflows.size === 0) {
    lines.push(theme.fg("dim", "  No workflows found."));
    lines.push(theme.fg("dim", "  Add one to .pi/workflows/ (e.g. .pi/workflows/my-flow.js)."));
    lines.push("");
    lines.push(border);
    return lines.map((line) => truncateToWidth(line, width));
  }

  for (const [name, def] of workflows) {
    lines.push(`  ${theme.fg("accent", theme.bold(name))}`);
    if (def.description) {
      lines.push(`    ${theme.fg("muted", def.description)}`);
    }
    // phases is a display-only hint (a "name⇉" suffix marks a parallel group).
    // Omitted → the body drives progress dynamically, so we say so.
    const phaseNames =
      def.phases && def.phases.length > 0
        ? def.phases.join(theme.fg("dim", " → "))
        : theme.fg("dim", "dynamic");
    lines.push(`    ${theme.fg("dim", "phases: ")}${phaseNames}`);
    lines.push("");
  }

  lines.push(theme.fg("dim", "  Run one with  /workflow <name>"));
  lines.push(theme.fg("dim", "  Press q or Esc to close"));
  lines.push("");
  lines.push(border);
  return lines.map((line) => truncateToWidth(line, width));
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry Point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Headless one-shot: run a workflow to completion, persist it, and exit the
 * process. Backs `--run-workflow <name> [--workflow-input "<text>"]`, giving an
 * external orchestrator the same "spawn pi → wait → read the result file" shape
 * it uses for any subprocess — but agent-free and deterministic. The
 * agent-facing peer is the run_workflow tool; both share this engine + the run
 * store, so a run fired either way is identical downstream. Prints the absolute
 * run-file path as the final stdout line; exits 0 (completed), 1 (failed), or 2
 * (unknown workflow name).
 */
async function runWorkflowHeadless(
  ctx: ExtensionContext,
  name: string,
  input: string,
): Promise<never> {
  const workflows = await discoverWorkflows(ctx.cwd).catch(
    () => new Map<string, LoadedWorkflow>(),
  );
  const def = workflows.get(name);
  if (!def) {
    const available = Array.from(workflows.keys()).join(", ") || "none";
    process.stderr.write(`[workflows] --run-workflow: "${name}" not found. Available: ${available}\n`);
    return process.exit(2);
  }

  const { runId, state } = await runRegistered(
    def,
    ctx.cwd,
    input,
    ctx.sessionManager?.getSessionId?.(),
    new AbortController(),
  );
  // Final stdout line = the run file's path; the spawning process reads the full
  // PersistedRun JSON (status + per-step output) from it, like a result file.
  process.stdout.write(`${runFilePath(runId, ctx.cwd)}\n`);
  return process.exit(state.status === "completed" ? 0 : 1);
}

export default function (pi: ExtensionAPI) {
  extensionApi = pi;

  // Headless trigger (agent-free peer of the run_workflow tool):
  //   pi --run-workflow <name> [--workflow-input "<text>"]
  // runs the workflow to completion, writes its run file, then exits. Launch it
  // from an orchestrator in a non-interactive mode, e.g.
  //   pi --mode rpc --no-session --run-workflow daily-brief --workflow-input "…"
  pi.registerFlag("run-workflow", {
    description: "Run a .pi/workflows workflow to completion headlessly, write its run file, then exit.",
    type: "string",
  });
  pi.registerFlag("workflow-input", {
    description: "Free-text input for --run-workflow (the workflow reads it as `args`).",
    type: "string",
  });

  // ── Tool: run_workflow ────────────────────────────────────────────────

  pi.registerTool({
    name: "run_workflow",
    label: "Run Workflow",
    description:
      "Start a defined .pi/workflows/*.js workflow. Runs in the background and returns immediately; pass `input` to parameterize it (the workflow reads it as `args`). Retrieve a finished run's full output later with get_workflow_result.",
    promptSnippet: "Run a named .pi/workflows/*.js workflow in the background",
    promptGuidelines: [
      "After calling run_workflow, briefly confirm it started and continue — it runs in the background; do not wait for it.",
      "To report a finished workflow, call get_workflow_result rather than re-running it.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the workflow to run" }),
      input: Type.Optional(
        Type.String({
          description:
            "Free-text input for the run, available to the workflow as `args` (e.g. the change to scout for, the topic to research). Optional.",
        }),
      ),
      wait: Type.Optional(
        Type.Boolean({
          description:
            "If true, block and return the full result when the workflow finishes. Default false: start in the background, return immediately, and notify on completion. Only set true if the user explicitly wants to wait.",
          default: false,
        }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Discover workflow definitions
      const workflows = await discoverWorkflows(ctx.cwd);
      const input = params.input ?? "";
      if (workflows.size === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No workflows found. Add one to .pi/workflows/ (e.g. .pi/workflows/my-flow.js)" +
                loadErrorsText(),
            },
          ],
          details: { workflows: [], loadErrors: workflowLoadErrors },
        };
      }

      const def = workflows.get(params.name);
      if (!def) {
        const available = Array.from(workflows.keys()).map((n) => `"${n}"`).join(", ");
        return {
          content: [
            {
              type: "text",
              text:
                `Workflow "${params.name}" not found. Available: ${available || "none"}` +
                loadErrorsText(),
            },
          ],
          details: { workflows: Array.from(workflows.keys()), loadErrors: workflowLoadErrors },
        };
      }

      const doWait = params.wait ?? false;
      const sessionId = ctx.sessionManager?.getSessionId?.();

      // For background execution, spawn async and return immediately
      if (!doWait) {
        const runId = startBackgroundRun(def, ctx.cwd, input, sessionId);

        return {
          content: [
            {
              type: "text",
              text:
                `Workflow "${def.name}" started in the background (run ${runId}). ` +
                `It runs while we keep talking; the conversation is not blocked. ` +
                `Retrieve its full output later with get_workflow_result (or the user can run /workflow-result, or read ${runFilePath(runId, ctx.cwd)}).`,
            },
          ],
          // Structured pointers so an RPC client watching tool_execution_end can
          // correlate this call to the run's on-disk file.
          details: { runId, name: def.name, file: runFilePath(runId, ctx.cwd), dir: runStoreDir(ctx.cwd) },
        };
      }

      // Synchronous execution with progress streaming, via the shared run helper.
      // Link the tool's abort signal so cancelling the call cancels the run.
      const abortController = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }

      const { state } = await runRegistered(def, ctx.cwd, input, sessionId, abortController, (updatedState) => {
        // Stream progress to the LLM as a compact step summary.
        const summary = Object.entries(updatedState.phases)
          .map(([name, pr]) => {
            const icon =
              pr.status === "completed" ? "✓" :
              pr.status === "running" ? "●" :
              pr.status === "failed" ? "✗" :
              pr.status === "skipped" ? "→" : "○";
            return `  ${icon} ${name}: ${pr.status}`;
          })
          .join("\n");
        onUpdate?.({
          content: [{ type: "text", text: `Workflow "${updatedState.name}" [${updatedState.status}]\n${summary}` }],
          details: updatedState,
        });
      });

      // Format final result
      if (state.status === "failed") {
        return {
          content: [
            {
              type: "text",
              text: `Workflow "${def.name}" failed: ${state.error || "Unknown error"}`,
            },
          ],
          details: state,
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text",
            text: buildResultText(def.name, state),
          },
        ],
        details: state,
      };
    },

    renderCall(args, theme, _context) {
      const label = theme.fg("toolTitle", theme.bold("run_workflow "));
      const name = theme.fg("accent", args.name);
      const wait = args.wait === false ? theme.fg("warning", " (background)") : "";
      return new Text(`${label}${name}${wait}`, 0, 0);
    },

    renderResult(result, _options, theme, _context) {
      const details = result.details as WorkflowRunState | undefined;
      if (!details) {
        return new Text(
          result.content[0]?.type === "text" ? result.content[0].text : "",
          0,
          0,
        );
      }

      const statusIcon =
        details.status === "completed" ? theme.fg("success", "✓") :
        details.status === "failed" ? theme.fg("error", "✗") :
        details.status === "cancelled" ? theme.fg("dim", "◼") :
        theme.fg("warning", "●");

      const dur = ((details.endTime ?? Date.now()) - details.startTime) / 1000;
      const durStr = dur < 60 ? `${dur.toFixed(1)}s` : `${(dur / 60).toFixed(1)}m`;
      const usageStr = formatUsage(totalRunUsage(details));
      const usageSuffix = usageStr ? ` ${theme.fg("dim", usageStr)}` : "";

      let text = `${statusIcon} ${theme.bold(details.name)} ${theme.fg("muted", `[${details.status}]`)} ${theme.fg("dim", durStr)}${usageSuffix}`;

      for (const [name, pr] of Object.entries(details.phases)) {
        const icon =
          pr.status === "completed" ? theme.fg("success", "✓") :
          pr.status === "running" ? theme.fg("warning", "●") :
          pr.status === "failed" ? theme.fg("error", "✗") :
          pr.status === "skipped" ? theme.fg("dim", "→") :
          theme.fg("dim", "○");
        text += `\n  ${icon} ${theme.fg("accent", name)}: ${theme.fg("muted", pr.status)}`;
        if (pr.error) text += `\n    ${theme.fg("error", pr.error.split("\n")[0])}`;
      }

      return new Text(text, 0, 0);
    },
  });

  // ── Tool: list_workflows ──────────────────────────────────────────────

  pi.registerTool({
    name: "list_workflows",
    label: "List Workflows",
    description: "List available workflows (from .pi/workflows/*.js) and their phases.",
    promptSnippet: "List available workflows",
    parameters: Type.Object({}),

    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const workflows = await discoverWorkflows(ctx.cwd);
      if (workflows.size === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No workflows found. Add one to .pi/workflows/ (e.g. .pi/workflows/my-flow.js)" +
                loadErrorsText(),
            },
          ],
          details: { loadErrors: workflowLoadErrors },
        };
      }

      const summaries: string[] = [];
      for (const [name, def] of workflows) {
        const desc = def.description ? `: ${def.description}` : "";
        const phaseNames =
          def.phases && def.phases.length > 0 ? def.phases.join(", ") : "dynamic";
        summaries.push(`- **${name}**${desc}\n  Phases: ${phaseNames}`);
      }

      return {
        content: [
          {
            type: "text",
            text: `Available workflows:\n\n${summaries.join("\n\n")}${loadErrorsText()}`,
          },
        ],
        details: { workflows: Array.from(workflows.keys()), loadErrors: workflowLoadErrors },
      };
    },

    renderCall(_args, theme, _context) {
      return new Text(theme.fg("toolTitle", theme.bold("list_workflows")), 0, 0);
    },
  });

  // ── Tool: get_workflow_result ─────────────────────────────────────────

  pi.registerTool({
    name: "get_workflow_result",
    label: "Get Workflow Result",
    description:
      "Pull a completed workflow run's full output into context on demand (results stay out of context until you call this).",
    promptSnippet: "Fetch a finished workflow's full result",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description: "Run id or workflow name. Defaults to the most recent run if omitted.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const run = findRun(params.name);
      if (!run) {
        return {
          content: [
            {
              type: "text",
              text: params.name
                ? `No workflow run found matching "${params.name}".`
                : "No workflow runs found yet.",
            },
          ],
          details: {},
        };
      }
      if (run.status === "running") {
        return {
          content: [
            {
              type: "text",
              text: `Workflow "${run.name}" is still running. Check /workflows for live progress.`,
            },
          ],
          details: run,
        };
      }
      const text =
        run.status === "failed"
          ? `Workflow "${run.name}" failed: ${run.error || "Unknown error"}`
          : buildResultText(run.name, run);
      return { content: [{ type: "text", text }], details: run };
    },

    renderCall(args, theme, _context) {
      const label = theme.fg("toolTitle", theme.bold("get_workflow_result "));
      return new Text(`${label}${theme.fg("accent", args.name || "(latest)")}`, 0, 0);
    },
  });

  // ── Command: /workflows ───────────────────────────────────────────────

  pi.registerCommand("workflows", {
    description: "Show live progress of workflow runs",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        // No TUI here (print / json / RPC). Emit a machine-readable summary
        // instead of erroring: a one-line notify plus a structured, non-waking
        // marker carrying the run-store dir + run ids/files for a programmatic
        // client. (The interactive live viewer needs ctx.ui.custom, a no-op here.)
        const runs = getRecentRuns(20);
        ctx.ui.notify(
          runs.length === 0
            ? "No workflow runs yet."
            : `Runs: ${runs.map((r) => `${r.id} ${r.name} [${r.status}]`).join("; ")}`,
          "info",
        );
        pi.sendMessage(
          {
            customType: "workflow-status",
            content: "workflow runs",
            display: false,
            details: {
              dir: runStoreDir(ctx.cwd),
              runs: runs.map((r) => ({
                id: r.id,
                name: r.name,
                status: r.status,
                file: runFilePath(r.id, ctx.cwd),
              })),
            },
          },
          { deliverAs: "nextTurn" },
        );
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        // Start with existing runs, poll for updates
        let runs = getRecentRuns(10);
        let pollTimer: ReturnType<typeof setInterval> | null = null;

        const render = (width: number): string[] => {
          return renderWorkflowProgress(runs, width, theme);
        };

        pollTimer = setInterval(() => {
          runs = getRecentRuns(10);
          tui.requestRender();
        }, 1000);

        return {
          handleInput(data: string) {
            if (
              matchesKey(data, "escape") ||
              matchesKey(data, "ctrl+c") ||
              matchesKey(data, "q")
            ) {
              if (pollTimer) clearInterval(pollTimer);
              done();
            }
          },
          render,
          invalidate() {},
        };
      });
    },
  });

  // ── Command: /workflow-list ───────────────────────────────────────────

  pi.registerCommand("workflow-list", {
    description: "List available workflows (.pi/workflows/*.js)",
    handler: async (_args, ctx) => {
      const workflows = await discoverWorkflows(ctx.cwd);

      if (workflowLoadErrors.length > 0) {
        ctx.ui.notify(
          `${workflowLoadErrors.length} workflow file(s) failed to load: ${workflowLoadErrors
            .map((e) => `${path.basename(e.file)} (${e.error.split("\n")[0]})`)
            .join("; ")}`,
          "error",
        );
      }

      if (!ctx.hasUI) {
        if (workflows.size === 0) {
          ctx.ui.notify("No workflows found. Add one to .pi/workflows/.", "warning");
        } else {
          ctx.ui.notify(`Workflows: ${Array.from(workflows.keys()).join(", ")}`, "info");
        }
        return;
      }

      await ctx.ui.custom<void>((_tui, theme, _kb, done) => ({
        handleInput(data: string) {
          if (
            matchesKey(data, "escape") ||
            matchesKey(data, "ctrl+c") ||
            matchesKey(data, "q") ||
            matchesKey(data, "return")
          ) {
            done();
          }
        },
        render: (width: number) => renderWorkflowList(workflows, width, theme),
        invalidate() {},
      }));
    },
  });

  // ── Command: /workflow <name> ─────────────────────────────────────────

  pi.registerCommand("workflow", {
    description:
      "Run a workflow: /workflow <name> [input...] [--wait]. Background by default (watch with /workflows); --wait blocks with live progress, then the result.",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // Only complete the first token (the name); once a space is typed the
      // remainder is free-text input (and the optional --wait flag).
      if (prefix.includes(" ")) return null;
      const items = cachedWorkflowNames
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      // `--wait` is a recognized token (stripped from the name/input wherever it
      // appears); everything else is the name (first token) then free-text input.
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const wait = tokens.includes("--wait");
      const rest = tokens.filter((t) => t !== "--wait");
      const name = rest[0] ?? "";
      const input = rest.slice(1).join(" ");

      const workflows = await discoverWorkflows(ctx.cwd);

      if (workflows.size === 0) {
        ctx.ui.notify(`No workflows found. Add one to .pi/workflows/.${loadErrorsText()}`, "warning");
        return;
      }
      if (!name) {
        ctx.ui.notify(
          `Usage: /workflow <name> [input...] [--wait]. Available: ${Array.from(workflows.keys()).join(", ")}`,
          "info",
        );
        return;
      }
      const def = workflows.get(name);
      if (!def) {
        ctx.ui.notify(
          `Workflow "${name}" not found. Available: ${Array.from(workflows.keys()).join(", ")}`,
          "error",
        );
        return;
      }

      const sessionId = ctx.sessionManager?.getSessionId?.();

      // ── --wait in the TUI: block on a live progress view, then a scrollable
      //    result. The run is the same background run; we just watch it (so Esc
      //    can cancel via its abortController) instead of forking away. ──
      if (wait && ctx.hasUI) {
        const runId = startBackgroundRun(def, ctx.cwd, input, sessionId, /* announce */ false);
        let offset = 0;
        let aborting = false;
        // Cache the wrapped result once the run is terminal (rebuild only on a
        // width change) so scrolling doesn't re-serialize the deliverable.
        let wrapped: string[] | null = null;
        let wrappedWidth = -1;
        await ctx.ui.custom<void>((tui, theme, _kb, done) => {
          const poll = setInterval(() => {
            const r = findRun(runId);
            if (r && r.status !== "running") clearInterval(poll);
            tui.requestRender();
          }, 700);
          return {
            handleInput(data: string) {
              const run = findRun(runId);
              const running = !!run && run.status === "running";
              if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
                if (running && !aborting) {
                  aborting = true; // first q/Esc while running → cancel; the view stays to show the outcome
                  registry.get(runId)?.abortController?.abort();
                  tui.requestRender();
                } else {
                  clearInterval(poll);
                  done();
                }
                return;
              }
              if (!running) {
                const next = scrollResultOffset(data, offset);
                if (next === null) return;
                offset = next;
                tui.requestRender();
              }
            },
            render(width: number): string[] {
              const run = findRun(runId);
              if (!run) return [theme.fg("dim", `  run ${runId} not found`)];
              if (run.status === "running") {
                const lines = renderWorkflowProgress([run], width, theme);
                lines.push(theme.fg("dim", aborting ? "  cancelling…" : "  running — q/Esc to cancel"));
                return lines.map((l) => truncateToWidth(l, width));
              }
              // Terminal → same scrollable result view as /workflow-result.
              if (!wrapped || wrappedWidth !== width) {
                wrapped = wrapResultLines(run, theme, width);
                wrappedWidth = width;
              }
              const maxOffset = Math.max(0, wrapped.length - RESULT_PAGE);
              if (offset > maxOffset) offset = maxOffset;
              return renderResultFrame(wrapped, offset, width, theme, `Workflow: ${run.name}`);
            },
            invalidate() {},
          };
        });
        return;
      }

      // ── --wait without a TUI (RPC / headless): run synchronously and emit a
      //    terminal marker so the caller learns the outcome + result-file path. ──
      if (wait) {
        const { runId, state } = await runRegistered(def, ctx.cwd, input, sessionId, new AbortController());
        pi.sendMessage(
          {
            customType: "workflow-status",
            content: `Workflow "${name}" (run ${runId}) ${state.status}.`,
            display: false,
            details: { runId, name, status: state.status, file: runFilePath(runId, ctx.cwd), dir: runStoreDir(ctx.cwd) },
          },
          { deliverAs: "nextTurn" },
        );
        ctx.ui.notify(`Workflow "${name}" ${state.status} (run ${runId}).`, state.status === "failed" ? "error" : "info");
        return;
      }

      // ── Background (default) ──
      const runId = startBackgroundRun(def, ctx.cwd, input, sessionId);
      // Structured, non-waking ack so an RPC frontend learns the run id (and the
      // path to its result file) without an LLM turn — /workflow is the
      // recommended programmatic trigger over RPC. deliverAs:"nextTurn" never
      // triggers a turn.
      pi.sendMessage(
        {
          customType: "workflow-status",
          content: `Started "${name}" (run ${runId}).`,
          display: false,
          details: { runId, name, status: "running", file: runFilePath(runId, ctx.cwd), dir: runStoreDir(ctx.cwd) },
        },
        { deliverAs: "nextTurn" },
      );
      ctx.ui.notify(
        `Started workflow "${name}" (run ${runId})${input ? ` (input: ${input.slice(0, 40)}${input.length > 40 ? "…" : ""})` : ""}. Run /workflows to watch progress.`,
        "info",
      );
    },
  });

  // ── Command: /workflow-result [name] ──────────────────────────────────

  pi.registerCommand("workflow-result", {
    description: "View the full result of a completed workflow run (no context cost)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const runs = getRecentRuns(100);
      // Offer run ids (newest first, labelled with name) and distinct names so a
      // run is addressable by either. Ids disambiguate multiple runs of one name.
      const items: AutocompleteItem[] = [
        ...runs.map((r) => ({ value: r.id, label: `${r.id} (${r.name})` })),
        ...Array.from(new Set(runs.map((r) => r.name))).map((n) => ({ value: n, label: n })),
      ].filter((i) => i.value.startsWith(prefix));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      // Resolve which run to view: an explicit arg (id first, then most-recent
      // by name); otherwise the single finished run, or a picker when several.
      const run = await (async (): Promise<WorkflowRunState | undefined> => {
        const arg = args.trim();
        if (arg) {
          const r = findRun(arg);
          if (!r) ctx.ui.notify(`No workflow run matching "${arg}".`, "info");
          return r;
        }
        const finished = getRecentRuns(50).filter((r) => r.status !== "running");
        if (finished.length === 0) {
          ctx.ui.notify("No completed workflow runs yet. Start one with /workflow <name>.", "info");
          return undefined;
        }
        if (finished.length === 1 || !ctx.hasUI) return finished[0];
        const labels = finished.map((r) => `${r.id} · ${r.name} · ${r.status} · ${ageStr(r)}`);
        const choice = await ctx.ui.select("View which run?", labels);
        return choice ? finished[labels.indexOf(choice)] : undefined;
      })();

      if (!run) return; // nothing to show (already notified where relevant)
      if (run.status === "running") {
        ctx.ui.notify(`Workflow "${run.name}" is still running — see /workflows.`, "info");
        return;
      }
      if (!ctx.hasUI) {
        // No TUI viewer here; emit a truncated summary + a structured marker
        // pointing at the full untruncated result file.
        ctx.ui.notify(buildResultText(run.name, run).slice(0, 300), "info");
        pi.sendMessage(
          {
            customType: "workflow-status",
            content: `result for ${run.name}`,
            display: false,
            details: { runId: run.id, name: run.name, status: run.status, file: runFilePath(run.id, ctx.cwd) },
          },
          { deliverAs: "nextTurn" },
        );
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let offset = 0;
        // `run` is terminal/immutable here, so wrap once per width.
        let wrapped: string[] | null = null;
        let wrappedWidth = -1;
        return {
          handleInput(data: string) {
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
              done();
              return;
            }
            const next = scrollResultOffset(data, offset);
            if (next === null) return;
            offset = next;
            tui.requestRender();
          },
          render(width: number): string[] {
            if (!wrapped || wrappedWidth !== width) {
              wrapped = wrapResultLines(run, theme, width);
              wrappedWidth = width;
            }
            const maxOffset = Math.max(0, wrapped.length - RESULT_PAGE);
            if (offset > maxOffset) offset = maxOffset;
            return renderResultFrame(wrapped, offset, width, theme, "Workflow Result");
          },
          invalidate() {},
        };
      });
    },
  });

  // ── Warm the workflow-name cache so /workflow autocomplete works ──────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    runStoreCwd = ctx.cwd;
    if (ctx.model) defaultModel = ctx.model;

    // Headless one-shot: `--run-workflow <name>` runs to completion and exits,
    // before this session ever becomes interactive. Agent-free peer of the
    // run_workflow tool — same engine + run store.
    const headlessName = pi.getFlag("run-workflow");
    if (typeof headlessName === "string" && headlessName.trim()) {
      const headlessInput = pi.getFlag("workflow-input");
      await runWorkflowHeadless(
        ctx,
        headlessName.trim(),
        typeof headlessInput === "string" ? headlessInput : "",
      );
      return; // unreachable — runWorkflowHeadless exits the process
    }

    // Reconcile the on-disk store: mark runs orphaned by a dead process as
    // interrupted, then prune. This is what makes runs survive /reload.
    try {
      rehydrateRuns(ctx.cwd);
      pruneRunStore(ctx.cwd);
    } catch {
      /* never let store maintenance break session start */
    }
    await discoverWorkflows(ctx.cwd).catch(() => {});
  });

  pi.on("model_select", async (event, ctx) => {
    currentCtx = ctx;
    if (event.model) defaultModel = event.model;
  });

  // ── Status: show active background runs in a widget BELOW the editor ──
  //
  // Deliberately rendered below the editor (not the default aboveEditor): pi's
  // own "Working…" loader row sits just above the editor, so an above-editor
  // widget with a status glyph + elapsed timer reads as a SECOND working
  // indicator. Below-editor + dim styling + the workflow name keeps it clearly
  // a separate "background workflow" panel. The static ● is intentionally NOT
  // pi's animated braille spinner. Cleared with undefined when nothing is live.

  const renderRunWidget = (active: WorkflowRunState[]) =>
    (_tui: unknown, theme: ThemeLike) => {
      const lines = active.map((r) => {
        const dur = ((Date.now() - r.startTime) / 1000).toFixed(0);
        const phase = r.currentPhase ? ` → ${r.currentPhase}` : "";
        return (
          theme.fg("accent", "● ") +
          theme.fg("muted", `${r.name}${phase}`) +
          theme.fg("dim", ` · ${dur}s`)
        );
      });
      return { render: () => lines, invalidate: () => {} };
    };

  const refreshRunWidget = (ctx: ExtensionContext) => {
    const active = getRecentRuns(10).filter((r) => r.status === "running");
    if (active.length === 0) {
      ctx.ui.setWidget("workflows", undefined); // clear
    } else {
      ctx.ui.setWidget("workflows", renderRunWidget(active), { placement: "belowEditor" });
    }
  };

  pi.on("turn_start", async (_event, ctx) => {
    currentCtx = ctx;
    runStoreCwd = ctx.cwd;
    if (ctx.model) defaultModel = ctx.model;
    refreshRunWidget(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    refreshRunWidget(ctx);
  });
}
