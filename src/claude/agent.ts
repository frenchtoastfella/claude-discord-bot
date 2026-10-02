import Anthropic from "@anthropic-ai/sdk";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { docsIndex } from "../docs/index.js";
import { getClient } from "./client.js";
import {
  addUsage,
  costOf,
  effectiveEffort,
  emptyUsage,
  getModel,
  type TokenUsage,
} from "./models.js";
import { docsTools, executeTool, type ToolContext } from "./tools.js";

const log = createLogger("agent");

export interface ConversationTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentEvents {
  /** Fired for every streamed text delta of the final answer. */
  onText?: (fullText: string) => void;
  /** Fired when a tool starts running, with a short description. */
  onToolStart?: (summary: string) => void;
  /** Fired when a tool finishes, with its result summary. */
  onToolEnd?: (summary: string) => void;
}

export interface AgentResult {
  text: string;
  usage: TokenUsage;
  costUsd: number;
  model: string;
  toolCalls: number;
  /** API requests made, including the final answer. */
  iterations: number;
  durationMs: number;
  stopReason: string | null;
  /** Populated when the run ended early or abnormally (refusal, token cap, tool budget). */
  warning: string | null;
}

/** A failed run. Carries what was spent before the failure so it still gets billed in the usage log. */
export class AgentError extends Error {
  constructor(
    message: string,
    readonly usage: TokenUsage,
    readonly costUsd: number,
    readonly model: string,
    readonly toolCalls: number,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AgentError";
  }
}

/** Docs index revision the current system prompt was built from. */
let cachedIndexVersion = -1;
let cachedSystemPrompt = "";
let cachedPromptKey = "";

function buildSystem(): Anthropic.TextBlockParam[] {
  const cfg = getConfig();
  const key = `${cfg.systemPrompt}::${cfg.docs.maxIndexEntries}::${cfg.docs.repoUrl}`;
  if (docsIndex.version !== cachedIndexVersion || key !== cachedPromptKey) {
    cachedSystemPrompt = docsIndex.renderIndexForPrompt();
    cachedIndexVersion = docsIndex.version;
    cachedPromptKey = key;
  }

  // Explicit breakpoint on the last system block: tools + system are cached
  // together and shared by every message until the docs change.
  return [
    { type: "text", text: cfg.systemPrompt },
    {
      type: "text",
      text:
        `${cachedSystemPrompt}\n\nThe index above may be truncated; use list_docs to see everything.\n\n` +
        "You also have tools for the Discord server itself — server_info, list_channels, list_roles. " +
        "Use them for questions about where to post something, what a channel is for, or what a role " +
        "grants. list_channels only returns channels the person asking can already see, so never " +
        "speculate about channels beyond what it returns.",
      cache_control: { type: "ephemeral" },
    },
  ];
}

const OUT_OF_BUDGET_NOTE =
  "You have used your tool budget for this question. Answer now from what you've found, " +
  "and say plainly if anything is still unverified.";

/**
 * Run one agentic turn: stream text, execute tools, loop until Claude stops
 * asking for tools. Returns the final answer plus accumulated usage.
 */
export async function runAgent(
  question: string,
  history: ConversationTurn[],
  events: AgentEvents = {},
  context: ToolContext = { server: null },
): Promise<AgentResult> {
  const cfg = getConfig();
  const model = getModel(cfg.model);
  const maxToolRounds = cfg.limits.maxToolIterations;
  const started = Date.now();
  const usage = emptyUsage();

  const messages: Anthropic.MessageParam[] = [
    ...history.map((turn) => ({ role: turn.role, content: turn.content }) as Anthropic.MessageParam),
    { role: "user", content: question },
  ];

  let finalText = "";
  let toolCalls = 0;
  let toolRounds = 0;
  let requests = 0;
  let stopReason: string | null = null;
  let warning: string | null = null;

  const request: Anthropic.MessageCreateParamsStreaming = {
    model: model.id,
    max_tokens: Math.min(cfg.maxTokens, model.maxOutputTokens),
    system: buildSystem(),
    tools: docsTools,
    messages,
    stream: true,
    // Second breakpoint, placed automatically on the last block. Every round of
    // the tool loop resends the whole conversation — history and all earlier tool
    // results — so without this each round re-bills them at the full input rate.
    cache_control: { type: "ephemeral" },
  };
  // Both are driven by the model's reported capabilities, so a newly released
  // model gets the right parameters without a code change.
  if (model.supportsAdaptiveThinking) {
    request.thinking = { type: "adaptive" };
  }
  const effort = effectiveEffort(cfg.effort, model);
  if (effort) {
    request.output_config = { effort };
    if (effort !== cfg.effort) {
      log.debug(`${model.id} doesn't support effort "${cfg.effort}", using "${effort}"`);
    }
  }

  try {
    for (;;) {
      requests++;
      // Out of tool budget: make Claude answer with what it has. Otherwise it
      // asks for one more tool we'd never run, and the user gets nothing.
      const outOfBudget = toolRounds >= maxToolRounds;
      const stream = getClient().messages.stream({
        ...request,
        messages,
        ...(outOfBudget ? { tool_choice: { type: "none" as const } } : {}),
      });

      // Only the last assistant turn's text is the answer — a turn that ends in a
      // tool call usually emits a short preamble we don't want to keep.
      let turnText = "";
      stream.on("text", (delta) => {
        turnText += delta;
        finalText = turnText;
        events.onText?.(finalText);
      });

      const message = await stream.finalMessage();
      const turnUsage = toTokenUsage(message.usage);
      addUsage(usage, turnUsage);
      stopReason = message.stop_reason;
      // LOG_LEVEL=debug shows whether caching is working: from the second request
      // on, cache_read should cover most of the input.
      log.debug(
        `request ${requests}: input=${turnUsage.inputTokens} cache_read=${turnUsage.cacheReadInputTokens} ` +
          `cache_write=${turnUsage.cacheCreationInputTokens} output=${turnUsage.outputTokens} stop=${message.stop_reason}`,
      );

      if (message.stop_reason === "refusal") {
        // A mid-stream refusal leaves partial output behind. It isn't an answer,
        // and keeping it would also replay it into the channel's history.
        finalText = "";
        events.onText?.("");
        warning = "Claude declined to answer this request.";
        break;
      }

      if (message.stop_reason !== "tool_use") {
        if (message.stop_reason === "max_tokens") {
          warning = "Response hit the max_tokens limit and was cut off.";
        } else if (outOfBudget) {
          warning = `Reached the limit of ${maxToolRounds} tool rounds, so this answer may be incomplete.`;
        }
        break;
      }

      messages.push({ role: "assistant", content: message.content });

      const toolUses = message.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
      );
      const results: (Anthropic.ToolResultBlockParam | Anthropic.TextBlockParam)[] = [];
      for (const toolUse of toolUses) {
        toolCalls++;
        events.onToolStart?.(describeToolStart(toolUse));
        const outcome = await executeTool(toolUse.name, toolUse.input, context);
        events.onToolEnd?.(outcome.summary);
        log.debug(`tool ${toolUse.name}: ${outcome.summary}`);
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: outcome.content,
          is_error: outcome.isError,
        });
      }
      toolRounds++;
      if (toolRounds >= maxToolRounds) results.push({ type: "text", text: OUT_OF_BUDGET_NOTE });

      messages.push({ role: "user", content: results });
      // Clear the preamble so a partial "let me check…" doesn't survive as the answer.
      finalText = "";
      events.onText?.("");
    }
  } catch (err) {
    throw new AgentError(
      err instanceof Error ? err.message : String(err),
      usage,
      costOf(model.id, usage),
      model.id,
      toolCalls,
      { cause: err },
    );
  }

  return {
    text: finalText.trim(),
    usage,
    costUsd: costOf(model.id, usage),
    model: model.id,
    toolCalls,
    iterations: requests,
    durationMs: Date.now() - started,
    stopReason,
    warning,
  };
}

/** The API reports usage in snake_case, and cache fields can be null. */
function toTokenUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationInputTokens: usage.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

function describeToolStart(toolUse: Anthropic.ToolUseBlock): string {
  const input = (toolUse.input ?? {}) as Record<string, unknown>;
  switch (toolUse.name) {
    case "search_docs":
      return `searching docs for "${String(input["query"] ?? "").slice(0, 60)}"`;
    case "read_doc":
      return `reading ${String(input["path"] ?? "")}`;
    case "list_docs":
      return `listing ${String(input["path_prefix"] ?? "docs")}`;
    case "list_channels":
      return "looking up this server's channels";
    case "list_roles":
      return "looking up this server's roles";
    case "server_info":
      return "checking server info";
    default:
      return `running ${toolUse.name}`;
  }
}
