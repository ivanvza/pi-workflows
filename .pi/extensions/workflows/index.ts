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
  BudgetConfig,
  FieldSpec,
  PhaseContext,
  PhaseDefinition,
  PhaseResult,
  Schema,
  SchemaField,
  SchemaInput,
  ThinkingLevel,
  WorkflowDefinition,
  WorkflowRunState,
} from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

const MAX_PARALLEL_TASKS = 8;
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

function resolvePrompt(
  prompt: string | ((ctx: PhaseContext) => string),
  ctx: PhaseContext,
): string {
  return typeof prompt === "function" ? prompt(ctx) : prompt;
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
// Phase Execution
// ═══════════════════════════════════════════════════════════════════════════

interface PhaseOutcome {
  output: any;
  usage: Usage;
}

async function executeSinglePhase(
  phase: PhaseDefinition,
  ctx: PhaseContext,
  cwd: string,
  signal: AbortSignal | undefined,
  budget: BudgetConfig | undefined,
  agents: Map<string, AgentConfig>,
): Promise<PhaseOutcome> {
  // ── Deterministic code phase ────────────────────────────────────────────
  // A phase with `code` executes plain JS instead of a sub-agent: no model, no
  // tokens, instant. Its return value becomes the phase output and flows to
  // later phases via ctx.previous, exactly like a model phase's output. This
  // lets you interleave code between models: model → code (logic) → model.
  if (phase.code) {
    const output = await phase.code(ctx);
    if (phase.schema) {
      // Optional: validate the returned object against the schema, same as models.
      validateSchema(normalizeSchema(phase.schema), output, phase.name);
    }
    return { output, usage: emptyUsage() };
  }

  const taskStr = resolvePrompt(phase.prompt ?? "", ctx);
  const timeout = phase.timeout ?? PHASE_TIMEOUT_MS;
  const mergedBudget: BudgetConfig = { ...budget, ...phase.budget };

  // Resolve the named agent (if any) into model / tools / system prompt.
  // Phase-level overrides win; the agent supplies the defaults.
  let agent: AgentConfig | undefined;
  if (phase.agent) {
    agent = agents.get(phase.agent);
    if (!agent) {
      const available = Array.from(agents.keys()).map((n) => `"${n}"`).join(", ") || "none";
      throw new Error(`Phase "${phase.name}" references unknown agent "${phase.agent}". Available: ${available}.`);
    }
  }
  const model = phase.model ?? agent?.model;
  const tools = phase.tools ?? agent?.tools;
  const thinking = phase.thinking ?? agent?.thinking;
  const schema = phase.schema ? normalizeSchema(phase.schema) : undefined;
  const systemPromptExtra =
    [agent?.systemPrompt, phase.systemPrompt].filter((s) => s && s.trim()).join("\n\n") || undefined;

  const result = await runSubagent(
    cwd,
    taskStr,
    model,
    tools,
    systemPromptExtra,
    schema,
    mergedBudget,
    thinking,
    timeout,
    signal,
  );

  const usage = result.usage ?? emptyUsage();

  if (result.exitCode !== 0 || result.stopReason === "error") {
    throw new Error(
      result.errorMessage || result.stderr || `Phase exited with code ${result.exitCode}`,
    );
  }

  // Extract structured output or raw text
  const finalText = getFinalAssistantText(result.messages);
  if (schema) {
    // Prefer the provide_result tool call; fall back to parsing a JSON block
    // from the final text in case the model answered in prose anyway.
    const parsed = result.structured ?? extractJsonFromText(finalText);
    if (!parsed) {
      throw new Error(`Phase "${phase.name}" did not produce valid structured output. Response: ${finalText.slice(0, 500)}`);
    }
    validateSchema(schema, parsed, phase.name);
    return { output: parsed, usage };
  }

  return { output: finalText, usage };
}

async function executeParallelPhase(
  phase: PhaseDefinition,
  ctx: PhaseContext,
  cwd: string,
  signal: AbortSignal | undefined,
  budget: BudgetConfig | undefined,
  agents: Map<string, AgentConfig>,
): Promise<PhaseOutcome> {
  const subPhases = phase.parallel!;

  if (subPhases.length > MAX_PARALLEL_TASKS) {
    throw new Error(`Too many parallel tasks (${subPhases.length}). Max is ${MAX_PARALLEL_TASKS}.`);
  }

  const results: Record<string, any> = {};
  const usage = emptyUsage();
  const errors: string[] = [];

  // Concurrency-limited parallel execution
  let nextIndex = 0;
  const workers = new Array(Math.min(MAX_CONCURRENCY, subPhases.length))
    .fill(null)
    .map(async () => {
      while (true) {
        const idx = nextIndex++;
        if (idx >= subPhases.length) return;
        const sub = subPhases[idx];
        try {
          // Build a synthetic PhaseDefinition for the sub-phase. The sub-phase
          // inherits the parent's agent/model/tools/prompt unless it sets its own.
          const subPhase: PhaseDefinition = {
            name: sub.name,
            description: sub.description,
            agent: sub.agent ?? phase.agent,
            prompt: sub.prompt,
            code: sub.code,
            model: sub.model ?? phase.model,
            tools: sub.tools ?? phase.tools,
            thinking: sub.thinking ?? phase.thinking,
            systemPrompt: sub.systemPrompt ?? phase.systemPrompt,
            schema: sub.schema,
            timeout: sub.timeout ?? phase.timeout,
          };
          const outcome = await executeSinglePhase(subPhase, ctx, cwd, signal, budget, agents);
          results[sub.name] = outcome.output;
          addUsage(usage, outcome.usage);
        } catch (err: any) {
          results[sub.name] = null;
          errors.push(`[${sub.name}] ${err.message}`);
        }
      }
    });

  await Promise.all(workers);

  if (errors.length > 0) {
    throw new Error(`Parallel phase "${phase.name}" had ${errors.length} failure(s):\n${errors.join("\n")}`);
  }

  return { output: results, usage };
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Engine
// ═══════════════════════════════════════════════════════════════════════════

type WorkflowRunCallback = (state: WorkflowRunState) => void;

async function executeWorkflow(
  workflowDef: WorkflowDefinition,
  cwd: string,
  onProgress: WorkflowRunCallback,
  signal: AbortSignal | undefined,
  runId?: string,
  input = "",
): Promise<WorkflowRunState> {
  const state: WorkflowRunState = {
    id: runId ?? generateId(),
    name: workflowDef.name,
    status: "running",
    phases: {},
    startTime: Date.now(),
  };

  const previous: Record<string, any> = {};
  const agents = discoverAgents(cwd);

  try {
    for (const phase of workflowDef.phases) {
      if (signal?.aborted) {
        state.status = "cancelled";
        break;
      }

      state.currentPhase = phase.name;

      // Initialize phase result
      state.phases[phase.name] = {
        phaseName: phase.name,
        status: "pending",
      };

      // Validate the phase has exactly one kind of work. Without this, a phase
      // missing prompt/code/parallel (e.g. a typo'd field, or an older engine
      // that doesn't recognize a newer field) would silently run a model with
      // an empty prompt instead of failing.
      const hasParallel = (phase.parallel?.length ?? 0) > 0;
      const hasCode = typeof phase.code === "function";
      const hasPrompt = phase.prompt != null;
      if (!hasParallel && !hasCode && !hasPrompt) {
        state.phases[phase.name] = {
          phaseName: phase.name,
          status: "failed",
          error: `Phase "${phase.name}" has no prompt, code, or parallel.`,
          duration: 0,
          attempts: 0,
        };
        state.status = "failed";
        state.error = state.phases[phase.name].error;
        break;
      }

      // Check condition
      const phaseCtx: PhaseContext = { previous: { ...previous }, input, workflow: state };
      if (phase.condition && !phase.condition(phaseCtx)) {
        state.phases[phase.name] = {
          phaseName: phase.name,
          status: "skipped",
          duration: 0,
          attempts: 0,
        };
        onProgress(state);
        continue;
      }

      // Execute (possibly with retries and loop)
      await executePhaseWithRetries(phase, phaseCtx, cwd, signal, state, onProgress, previous, agents);

      onProgress(state);

      // Check if phase failed and propagate
      const pr = state.phases[phase.name];
      if (pr.status === "failed") {
        state.status = "failed";
        state.error = pr.error;
        break;
      }
    }

    if (state.status === "running") {
      state.status = "completed";
    }
    state.endTime = Date.now();
    state.currentPhase = undefined;
    onProgress(state);

    return state;
  } catch (err: any) {
    state.status = "failed";
    state.error = err.message;
    state.endTime = Date.now();
    state.currentPhase = undefined;
    onProgress(state);
    return state;
  }
}

async function executePhaseWithRetries(
  phase: PhaseDefinition,
  ctx: PhaseContext,
  cwd: string,
  signal: AbortSignal | undefined,
  state: WorkflowRunState,
  onProgress: WorkflowRunCallback,
  previous: Record<string, any>,
  agents: Map<string, AgentConfig>,
): Promise<void> {
  const maxAttempts = 1 + (phase.retries ?? 0);
  const retryDelay = phase.retryDelay ?? DEFAULT_RETRY_DELAY;

  const shouldLoop = phase.loop != null;
  const maxIterations = shouldLoop ? phase.loop!.maxIterations : 1;

  const phaseStart = Date.now();
  const aggUsage = emptyUsage();
  let totalAttempts = 0;
  let lastOutput: any;
  let ranAtLeastOnce = false;

  const cancel = () => {
    state.phases[phase.name] = {
      phaseName: phase.name,
      status: "failed",
      error: "Cancelled",
      usage: aggUsage,
      duration: Date.now() - phaseStart,
      attempts: totalAttempts,
    };
  };

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    if (signal?.aborted) return cancel();

    // After the first iteration, the loop condition decides whether to continue.
    // It sees this phase's latest output via `previous`.
    if (shouldLoop && iteration > 0 && phase.loop!.condition) {
      const loopCtx: PhaseContext = { previous: { ...previous }, input: ctx.input, workflow: state };
      if (!phase.loop!.condition(loopCtx)) break;
    }

    // Build the prompt for this iteration (model phases). Code phases have no
    // prompt — phase.prompt is undefined and the branch in executeSinglePhase
    // runs the code instead.
    let promptText: string;
    if (shouldLoop && phase.loop!.promptTemplate) {
      const loopCtx: PhaseContext = { previous: { ...previous }, input: ctx.input, workflow: state };
      promptText = phase.loop!.promptTemplate(iteration, loopCtx);
    } else {
      promptText = resolvePrompt(phase.prompt ?? "", ctx);
    }
    // Carry the resolved prompt so executeSinglePhase uses this iteration's text.
    const iterPhase: PhaseDefinition = { ...phase, prompt: promptText };

    let lastError: Error | undefined;
    let succeeded = false;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) return cancel();
      totalAttempts++;

      state.phases[phase.name] = {
        phaseName: shouldLoop ? `${phase.name}[${iteration}]` : phase.name,
        status: "running",
        attempts: attempt + 1,
        usage: { ...aggUsage },
        duration: Date.now() - phaseStart,
      };
      onProgress(state);

      try {
        const outcome =
          phase.parallel && phase.parallel.length > 0
            ? await executeParallelPhase(iterPhase, ctx, cwd, signal, phase.budget, agents)
            : await executeSinglePhase(iterPhase, ctx, cwd, signal, phase.budget, agents);

        addUsage(aggUsage, outcome.usage);
        let output = outcome.output;

        // Apply map transform
        if (phase.map) {
          const mapCtx: PhaseContext = { previous: { ...previous }, input: ctx.input, workflow: state };
          output = phase.map(output, mapCtx);
        }

        lastOutput = output;
        ranAtLeastOnce = true;
        // Visible to the next iteration's condition/promptTemplate.
        previous[phase.name] = output;
        succeeded = true;
        break; // exit the retry loop; continue to the next iteration
      } catch (err: any) {
        lastError = err;
        if (attempt < maxAttempts - 1) await sleep(retryDelay);
      }
    }

    if (!succeeded) {
      state.phases[phase.name] = {
        phaseName: phase.name,
        status: "failed",
        error: lastError?.message,
        usage: aggUsage,
        duration: Date.now() - phaseStart,
        attempts: totalAttempts,
      };
      return; // Stop looping on failure
    }
  }

  // All iterations succeeded (or the loop condition ended it). The stored
  // output is the final iteration's result.
  state.phases[phase.name] = {
    phaseName: phase.name,
    status: "completed",
    output: lastOutput,
    usage: aggUsage,
    duration: Date.now() - phaseStart,
    attempts: totalAttempts,
  };
  if (ranAtLeastOnce) previous[phase.name] = lastOutput;
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow Registry (in-memory state)
// ═══════════════════════════════════════════════════════════════════════════

interface WorkflowRegistryEntry {
  run: WorkflowRunState;
  definition: WorkflowDefinition;
  abortController?: AbortController;
}

const registry = new Map<string, WorkflowRegistryEntry>();

/** Latest ExtensionContext seen via events, so background callbacks (which run
 *  with no ctx of their own) can still reach ctx.ui for notifications. */
let currentCtx: ExtensionContext | null = null;

/** The ExtensionAPI, captured at load, so background callbacks can nudge the
 *  agent (pi.sendMessage) when a workflow finishes. */
let extensionApi: ExtensionAPI | null = null;

function getRecentRuns(limit = 5): WorkflowRunState[] {
  return Array.from(registry.values())
    .map((e) => e.run)
    .sort((a, b) => b.startTime - a.startTime)
    .slice(0, limit);
}

/** Find a run by name or run id. Defaults to the most recent run.
 *  When matching by name, prefers the most recent run with that name. */
function findRun(nameOrId?: string): WorkflowRunState | undefined {
  const runs = getRecentRuns(100);
  if (!nameOrId) return runs[0];
  const key = nameOrId.trim();
  return runs.find((r) => r.id === key) ?? runs.find((r) => r.name === key);
}

// ═══════════════════════════════════════════════════════════════════════════
// Workflow File Loading
// ═══════════════════════════════════════════════════════════════════════════

function isWorkflowDef(value: any): value is WorkflowDefinition {
  return (
    value &&
    typeof value === "object" &&
    typeof value.name === "string" &&
    Array.isArray(value.phases)
  );
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

/** Pull every workflow definition out of an imported module (default export,
 *  named exports, or the module-as-workflow fallback). */
function extractWorkflows(
  mod: Record<string, any>,
  file: string,
  into: Map<string, WorkflowDefinition>,
): void {
  let found = 0;
  if (isWorkflowDef(mod.default)) {
    into.set(mod.default.name, mod.default);
    found++;
  }
  for (const [key, value] of Object.entries(mod)) {
    if (key === "default") continue;
    if (isWorkflowDef(value)) {
      into.set(value.name, value as WorkflowDefinition);
      found++;
    }
  }
  // Fallback: the module itself might be a workflow (jiti's interopDefault).
  if (found === 0 && isWorkflowDef(mod)) {
    into.set(
      mod.name || path.basename(file, path.extname(file)),
      mod as unknown as WorkflowDefinition,
    );
  }
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

async function discoverWorkflows(cwd: string): Promise<Map<string, WorkflowDefinition>> {
  const workflows = new Map<string, WorkflowDefinition>();
  const errors: Array<{ file: string; error: string }> = [];

  for (const file of collectWorkflowFiles(cwd)) {
    try {
      const mod = await importWorkflowFile(file);
      extractWorkflows(mod, file, workflows);
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

/** Start a workflow in the background: register it so /workflows can track it,
 *  run it detached, and NOTIFY (not inject) on completion. The full result
 *  stays in the registry — pulled into context only via get_workflow_result,
 *  or viewed without context cost via /workflow-result. */
function startBackgroundRun(def: WorkflowDefinition, cwd: string, input = ""): string {
  const abortController = new AbortController();
  const runId = generateId();
  const runState: WorkflowRunState = {
    id: runId,
    name: def.name,
    status: "running",
    phases: {},
    startTime: Date.now(),
  };
  registry.set(runId, { run: runState, definition: def, abortController });

  // Fire the toast + agent-nudge exactly once, when the run reaches a terminal
  // state. onProgress can be called repeatedly; this guard keeps it to one.
  let announced = false;

  /**
   * Nudge the agent to tell the user the run is done. Delivered as a follow-up
   * so it never interrupts whatever the agent is currently doing; `triggerTurn`
   * makes it respond right away if idle. `display: false` keeps the nudge itself
   * out of the transcript — only the agent's announcement shows.
   */
  const nudgeAgent = (content: string) => {
    extensionApi?.sendMessage(
      { customType: "workflow-status", content, display: false },
      { deliverAs: "followUp", triggerTurn: true },
    );
  };

  executeWorkflow(
    def,
    cwd,
    (updated) => {
      const entry = registry.get(runId);
      if (entry) entry.run = updated;

      if (announced) return;
      if (updated.status === "completed") {
        announced = true;
        currentCtx?.ui.notify(
          `Workflow "${def.name}" complete. /workflow-result to view, or ask me to pull it in.`,
          "info",
        );
        nudgeAgent(
          `The background workflow "${def.name}" just finished successfully. ` +
            "In one short sentence, let the user know it's done and that they can view the full " +
            "results with the /workflow-result command (or ask you to pull them in via " +
            "get_workflow_result). Do not fetch or summarize the results unless the user asks.",
        );
      } else if (updated.status === "failed") {
        announced = true;
        currentCtx?.ui.notify(
          `Workflow "${def.name}" failed: ${updated.error || "Unknown error"}`,
          "error",
        );
        nudgeAgent(
          `The background workflow "${def.name}" just failed: ${updated.error || "Unknown error"}. ` +
            "Briefly let the user know it failed and offer to look into it.",
        );
      }
    },
    abortController.signal,
    runId,
    input,
  ).catch(() => {});

  return runId;
}

/** Format a completed run's per-phase outputs into a readable summary,
 *  closing with the token usage that stayed out of the main context.
 *
 *  Intermediate phases are truncated to keep the main context lean, but the
 *  LAST completed phase — typically the workflow's actual deliverable (a report,
 *  a final answer) — is kept in full so it isn't silently clipped. */
function buildResultText(name: string, state: WorkflowRunState): string {
  const completed = Object.entries(state.phases).filter(
    ([, pr]) => pr.status === "completed" && pr.output != null,
  );
  const lastIdx = completed.length - 1;
  const phaseSummaries: string[] = [];
  completed.forEach(([phaseName, pr], idx) => {
    const outputStr =
      typeof pr.output === "string" ? pr.output : JSON.stringify(pr.output, null, 2);
    const keepFull = idx === lastIdx;
    const truncated =
      keepFull || outputStr.length <= 2000 ? outputStr : `${outputStr.slice(0, 1997)}...`;
    phaseSummaries.push(`### ${phaseName}\n${truncated}`);
  });
  const body =
    phaseSummaries.length > 0
      ? phaseSummaries.join("\n\n")
      : "Workflow completed with no output.";
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

  for (const [phaseName, pr] of Object.entries(state.phases)) {
    lines.push(theme.fg("accent", theme.bold(`### ${phaseName}`)) + theme.fg("dim", ` (${pr.status})`));
    if (pr.error) lines.push(theme.fg("error", pr.error));
    if (pr.output != null) {
      const text =
        typeof pr.output === "string" ? pr.output : JSON.stringify(pr.output, null, 2);
      for (const l of text.split("\n")) lines.push(theme.fg("muted", l));
    }
    lines.push("");
  }
  return lines;
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
        icon = theme.fg("warning", "â¦");
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
      `  ${icon} ${theme.bold(run.name)} ${theme.fg("muted", `[${run.status}]`)} ${theme.fg("dim", durStr)}${usageSuffix}`,
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
          statusIcon = theme.fg("warning", "â¦");
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
  workflows: Map<string, WorkflowDefinition>,
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
    const phaseNames = def.phases
      .map((p) => (p.parallel && p.parallel.length > 0 ? `${p.name}⇉` : p.name))
      .join(theme.fg("dim", " → "));
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

export default function (pi: ExtensionAPI) {
  extensionApi = pi;

  // ── Tool: run_workflow ────────────────────────────────────────────────

  pi.registerTool({
    name: "run_workflow",
    label: "Run Workflow",
    description: [
      "Start a defined workflow (from .pi/workflows/*.js).",
      "Runs in the BACKGROUND by default and returns immediately, so the conversation is never blocked while phases execute.",
      "Workflows execute phases sequentially or in parallel using sub-agents; outputs flow phase to phase via code, never touching the main context window.",
      "Pass `input` to parameterize the run — phases read it via ctx.input (e.g. what change to scout for, what topic to research).",
      "When a background run finishes, the user is notified and you receive a follow-up nudge to announce it; retrieve its full output later with get_workflow_result.",
      "Supports structured schemas, conditionals, loops, budgets, and automatic retries.",
    ].join(" "),
    promptSnippet: "Start a named workflow in the background (orchestrated by code, not the LLM)",
    promptGuidelines: [
      "Use run_workflow when the user wants to execute a multi-step workflow defined in .pi/workflows/.",
      "Pass run_workflow's `input` with the user's specifics (the change to make, the topic to research) when the workflow expects parameterization.",
      "run_workflow starts in the background by default and returns right away — after calling it, briefly confirm it started and continue; do NOT wait for it.",
      "Do not set wait:true unless the user explicitly asks to block until the workflow finishes.",
      "To report a finished workflow's results, call get_workflow_result rather than re-running it.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the workflow to run" }),
      input: Type.Optional(
        Type.String({
          description:
            "Free-text input for the run, available to phases as ctx.input (e.g. the change to scout for, the topic to research). Optional.",
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

      // For background execution, spawn async and return immediately
      if (!doWait) {
        const runId = startBackgroundRun(def, ctx.cwd, input);

        return {
          content: [
            {
              type: "text",
              text:
                `Workflow "${def.name}" started in the background (run ${runId}). ` +
                `The conversation is not blocked — it runs while we keep talking. ` +
                `Watch progress with /workflows; you'll be notified on completion, and can view the full output with /workflow-result or by asking me to fetch it.`,
            },
          ],
          details: { runId },
        };
      }

      // Synchronous execution with progress streaming
      const abortController = new AbortController();
      if (signal) {
        signal.addEventListener("abort", () => abortController.abort(), { once: true });
      }

      const state = await executeWorkflow(
        def,
        ctx.cwd,
        (updatedState) => {
          // Stream progress to the LLM
          const phaseEntries = Object.entries(updatedState.phases);
          const summary = phaseEntries
            .map(([name, pr]) => {
              const icon =
                pr.status === "completed" ? "✓" :
                pr.status === "running" ? "â¦" :
                pr.status === "failed" ? "✗" :
                pr.status === "skipped" ? "→" : "○";
              return `  ${icon} ${name}: ${pr.status}`;
            })
            .join("\n");

          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Workflow "${updatedState.name}" [${updatedState.status}]\n${summary}`,
              },
            ],
            details: updatedState,
          });
        },
        abortController.signal,
        undefined,
        input,
      );

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
        theme.fg("warning", "â¦");

      const dur = ((details.endTime ?? Date.now()) - details.startTime) / 1000;
      const durStr = dur < 60 ? `${dur.toFixed(1)}s` : `${(dur / 60).toFixed(1)}m`;
      const usageStr = formatUsage(totalRunUsage(details));
      const usageSuffix = usageStr ? ` ${theme.fg("dim", usageStr)}` : "";

      let text = `${statusIcon} ${theme.bold(details.name)} ${theme.fg("muted", `[${details.status}]`)} ${theme.fg("dim", durStr)}${usageSuffix}`;

      for (const [name, pr] of Object.entries(details.phases)) {
        const icon =
          pr.status === "completed" ? theme.fg("success", "✓") :
          pr.status === "running" ? theme.fg("warning", "â¦") :
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
        const phaseNames = def.phases.map((p) => p.name).join(", ");
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
    description: [
      "Retrieve the full result of a workflow run that already executed (e.g. one started in the background).",
      "Results are kept out of context until you call this; use it to pull a completed run's output into context on demand.",
    ].join(" "),
    promptSnippet: "Pull a completed workflow's full result into context",
    promptGuidelines: [
      "Use get_workflow_result when the user asks about the outcome of a workflow that finished running in the background.",
    ],
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Workflow name or run id. Defaults to the most recent run if omitted.",
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
        ctx.ui.notify("/workflows requires interactive mode", "error");
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
    description: "Run a workflow in the background: /workflow <name> [input...] (watch with /workflows)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      // Only complete the first token (the name); once a space is typed the
      // remainder is free-text input and shouldn't be autocompleted.
      if (prefix.includes(" ")) return null;
      const items = cachedWorkflowNames
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      // First token is the workflow name; the rest is free-text input (ctx.input).
      const spaceIdx = trimmed.search(/\s/);
      const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const input = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      const workflows = await discoverWorkflows(ctx.cwd);

      if (workflows.size === 0) {
        ctx.ui.notify(
          `No workflows found. Add one to .pi/workflows/.${loadErrorsText()}`,
          "warning",
        );
        return;
      }
      if (!name) {
        ctx.ui.notify(
          `Usage: /workflow <name> [input...]. Available: ${Array.from(workflows.keys()).join(", ")}`,
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

      startBackgroundRun(def, ctx.cwd, input);
      ctx.ui.notify(
        `Started workflow "${name}"${input ? ` (input: ${input.slice(0, 40)}${input.length > 40 ? "…" : ""})` : ""}. Run /workflows to watch progress.`,
        "info",
      );
    },
  });

  // ── Command: /workflow-result [name] ──────────────────────────────────

  pi.registerCommand("workflow-result", {
    description: "View the full result of a completed workflow run (no context cost)",
    getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
      const names = Array.from(new Set(getRecentRuns(100).map((r) => r.name)));
      const items = names
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const run = findRun(args.trim() || undefined);
      if (!run) {
        ctx.ui.notify("No workflow runs yet. Start one with /workflow <name>.", "info");
        return;
      }
      if (run.status === "running") {
        ctx.ui.notify(`Workflow "${run.name}" is still running — see /workflows.`, "info");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify(buildResultText(run.name, run).slice(0, 300), "info");
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        let offset = 0;
        const PAGE = 22; // visible content rows

        return {
          handleInput(data: string) {
            if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
              done();
              return;
            }
            if (matchesKey(data, "down") || matchesKey(data, "j")) offset += 1;
            else if (matchesKey(data, "up") || matchesKey(data, "k")) offset -= 1;
            else if (matchesKey(data, "space") || matchesKey(data, "pageDown")) offset += PAGE;
            else if (matchesKey(data, "pageUp") || matchesKey(data, "b")) offset -= PAGE;
            else return;
            if (offset < 0) offset = 0;
            tui.requestRender();
          },
          render(width: number): string[] {
            const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
            // Wrap full result content to the available width.
            const wrapped: string[] = [];
            for (const line of buildResultLines(run, theme)) {
              if (line === "") wrapped.push("");
              else for (const w of wrapTextWithAnsi(line, width)) wrapped.push(w);
            }
            const maxOffset = Math.max(0, wrapped.length - PAGE);
            if (offset > maxOffset) offset = maxOffset;
            const view = wrapped.slice(offset, offset + PAGE);

            const more = wrapped.length > PAGE;
            const pos = more
              ? `  ${offset + 1}-${Math.min(offset + PAGE, wrapped.length)} / ${wrapped.length}`
              : "";
            const hint = more ? "↑/↓ or space scroll · q/Esc close" : "q/Esc close";

            const out: string[] = [];
            out.push(border);
            const title = theme.fg("accent", theme.bold(" Workflow Result "));
            out.push(title + theme.fg("dim", pos));
            out.push(border);
            out.push(...view);
            // Pad so the footer stays put on short content.
            for (let i = view.length; i < PAGE; i++) out.push("");
            out.push(theme.fg("dim", `  ${hint}`));
            out.push(border);
            return out.map((l) => truncateToWidth(l, width));
          },
          invalidate() {},
        };
      });
    },
  });

  // ── Warm the workflow-name cache so /workflow autocomplete works ──────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.model) defaultModel = ctx.model;
    await discoverWorkflows(ctx.cwd).catch(() => {});
  });

  pi.on("model_select", async (event, ctx) => {
    currentCtx = ctx;
    if (event.model) defaultModel = event.model;
  });

  // ── Status line: show running workflow count via footer widget ───────

  pi.on("turn_start", async (_event, ctx) => {
    currentCtx = ctx;
    if (ctx.model) defaultModel = ctx.model;
    const runs = getRecentRuns(10);
    const active = runs.filter((r) => r.status === "running");
    if (active.length > 0) {
      const widgets = active.map((r) => {
        const dur = ((Date.now() - r.startTime) / 1000).toFixed(0);
        const phase = r.currentPhase || "";
        return `â¦ ${r.name} (${dur}s)${phase ? ` → ${phase}` : ""}`;
      });
      ctx.ui.setWidget("workflows", widgets);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    currentCtx = ctx;
    const active = getRecentRuns(10).filter((r) => r.status === "running");
    if (active.length === 0) {
      ctx.ui.setWidget("workflows", []);
    }
  });
}
