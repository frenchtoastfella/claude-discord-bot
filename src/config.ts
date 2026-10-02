import fs from "node:fs";
import path from "node:path";
import { configFile, ensureDataDir } from "./paths.js";
import { createLogger } from "./logger.js";
import { DEFAULT_MODEL, EFFORT_LEVELS, type Effort } from "./claude/models.js";

const log = createLogger("config");

export type { Effort };

export interface BotConfig {
  /** Anthropic model id, e.g. "claude-opus-5". */
  model: string;
  /** Reasoning depth / token spend. Ignored for models that don't support it. */
  effort: Effort;
  /** Hard ceiling on output tokens per assistant turn (thinking + text). */
  maxTokens: number;
  /** Persona and answering rules. Docs index + tool instructions are appended automatically. */
  systemPrompt: string;

  docs: {
    /** HTTPS or SSH git URL. Empty = docs tools disabled. */
    repoUrl: string;
    branch: string;
    /** Restrict indexing to a subdirectory of the repo, e.g. "docs". Empty = whole repo. */
    subdir: string;
    /** Glob patterns (relative to subdir) to index. */
    includeGlobs: string[];
    excludeGlobs: string[];
    /** 0 disables automatic pulling. */
    pullIntervalMinutes: number;
    /** Cap on how many files are listed in the cached system prompt. */
    maxIndexEntries: number;
  };

  discord: {
    respondToMentions: boolean;
    respondToReplies: boolean;
    respondToDMs: boolean;
    /** Channels where every message is answered, no mention needed. */
    alwaysRespondChannelIds: string[];
    /** Empty = all guilds allowed. */
    allowedGuildIds: string[];
    blockedUserIds: string[];
    /** Append a small token/cost line under each answer. */
    showUsageFooter: boolean;
    /** Show "searching docs…" progress while the agent works. */
    showToolActivity: boolean;
  };

  conversation: {
    /** How many prior user+assistant exchanges to replay per channel. */
    maxTurns: number;
    /** Forget a channel's history after this long with no activity. */
    ttlMinutes: number;
  };

  limits: {
    maxRequestsPerUserPerHour: number;
    /** Safety valve on the agentic loop. */
    maxToolIterations: number;
    /** 0 = unlimited. Bot refuses new requests once today's spend exceeds this. */
    dailyCostLimitUsd: number;
  };
}

export const DEFAULT_SYSTEM_PROMPT = `You are a documentation assistant in a Discord server.

Answer questions about the project using the documentation tools available to you.

Rules:
- Search the docs before answering anything project-specific. Do not answer from memory when a tool could confirm it.
- Cite the files you used, as \`path/to/file.md\`. If you quote, keep quotes short.
- If the docs do not cover something, say so plainly instead of guessing. Suggest where the answer might live.
- Answer in Discord-flavored markdown. Keep it tight — a few short paragraphs or a compact list. Use code blocks for code, commands, and config.
- No preamble ("Great question!", "Let me look into that"). Lead with the answer.
- For general programming questions unrelated to this project, answer directly without searching.`;

export const defaultConfig: BotConfig = {
  model: DEFAULT_MODEL,
  effort: "medium",
  // A ceiling, not a target: it covers thinking *and* the answer, and you only
  // pay for tokens actually generated. Too low just truncates answers mid-thought.
  maxTokens: 16000,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  docs: {
    repoUrl: "",
    branch: "main",
    subdir: "",
    includeGlobs: ["**/*.md", "**/*.mdx", "**/*.txt", "**/*.rst"],
    excludeGlobs: ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**", "**/vendor/**"],
    pullIntervalMinutes: 15,
    maxIndexEntries: 400,
  },
  discord: {
    respondToMentions: true,
    respondToReplies: true,
    respondToDMs: true,
    alwaysRespondChannelIds: [],
    allowedGuildIds: [],
    blockedUserIds: [],
    showUsageFooter: true,
    showToolActivity: true,
  },
  conversation: {
    maxTurns: 8,
    ttlMinutes: 120,
  },
  limits: {
    maxRequestsPerUserPerHour: 30,
    maxToolIterations: 12,
    dailyCostLimitUsd: 0,
  },
};

type Listener = (config: BotConfig, previous: BotConfig) => void;

let current: BotConfig = structuredClone(defaultConfig);
const listeners = new Set<Listener>();

/** Deep-merge a partial config over a base, ignoring unknown keys and type mismatches. */
function merge<T>(base: T, patch: unknown): T {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base)) {
    return (Array.isArray(patch) ? patch : base) as T;
  }
  if (typeof base === "object") {
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    if (typeof patch !== "object" || Array.isArray(patch)) return base;
    for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
      if (!(key in out)) continue;
      out[key] = merge(out[key], value);
    }
    return out as T;
  }
  return (typeof patch === typeof base ? patch : base) as T;
}

function sanitize(config: BotConfig): BotConfig {
  const c = structuredClone(config);

  // Deliberately *not* checked against the model list: the list loads after the
  // config and changes as Anthropic ships models, so rejecting unknown ids here
  // would silently reset a valid new model to the default. A genuinely bad id
  // fails loudly on the first request instead.
  c.model = String(c.model ?? "").trim();
  if (!/^[a-z0-9][a-z0-9.\-_]*$/i.test(c.model)) {
    if (c.model) log.warn(`invalid model id "${c.model}", falling back to ${DEFAULT_MODEL}`);
    c.model = DEFAULT_MODEL;
  }
  if (!EFFORT_LEVELS.includes(c.effort)) c.effort = defaultConfig.effort;

  c.maxTokens = clamp(Math.round(c.maxTokens), 512, 64000);
  c.docs.pullIntervalMinutes = clamp(Math.round(c.docs.pullIntervalMinutes), 0, 24 * 60);
  c.docs.maxIndexEntries = clamp(Math.round(c.docs.maxIndexEntries), 20, 5000);
  c.conversation.maxTurns = clamp(Math.round(c.conversation.maxTurns), 0, 50);
  c.conversation.ttlMinutes = clamp(Math.round(c.conversation.ttlMinutes), 1, 7 * 24 * 60);
  c.limits.maxRequestsPerUserPerHour = clamp(Math.round(c.limits.maxRequestsPerUserPerHour), 0, 10000);
  c.limits.maxToolIterations = clamp(Math.round(c.limits.maxToolIterations), 1, 50);
  c.limits.dailyCostLimitUsd = Math.max(0, Number(c.limits.dailyCostLimitUsd) || 0);

  // These reach `git` as arguments. A value starting with "-" would be parsed as an
  // option (`--upload-pack=...` runs an arbitrary command), so refuse it outright.
  c.docs.repoUrl = c.docs.repoUrl.trim();
  if (c.docs.repoUrl.startsWith("-")) {
    log.warn("refusing a repository URL that starts with '-'");
    c.docs.repoUrl = "";
  }
  c.docs.branch = c.docs.branch.trim() || "main";
  if (!/^(?!-)(?!.*\.\.)[^\s~^:?*[\\\x00-\x1f]+$/.test(c.docs.branch)) {
    log.warn(`invalid branch name "${c.docs.branch}", using "main"`);
    c.docs.branch = "main";
  }
  c.docs.subdir = c.docs.subdir.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (c.docs.subdir.split(/[\\/]/).includes("..")) {
    // Would index files outside the clone — potentially the whole disk.
    log.warn(`subdirectory "${c.docs.subdir}" escapes the repository, ignoring it`);
    c.docs.subdir = "";
  }
  c.docs.includeGlobs = cleanList(c.docs.includeGlobs);
  c.docs.excludeGlobs = cleanList(c.docs.excludeGlobs);
  c.discord.alwaysRespondChannelIds = cleanList(c.discord.alwaysRespondChannelIds);
  c.discord.allowedGuildIds = cleanList(c.discord.allowedGuildIds);
  c.discord.blockedUserIds = cleanList(c.discord.blockedUserIds);
  c.systemPrompt = c.systemPrompt.slice(0, 50_000);

  return c;
}

function cleanList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))];
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(): BotConfig {
  ensureDataDir();
  if (fs.existsSync(configFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configFile, "utf8"));
      current = sanitize(merge(structuredClone(defaultConfig), raw));
      log.info(`loaded config from ${configFile}`);
    } catch (err) {
      // Keep the broken file: the next save from the panel would otherwise
      // overwrite it with defaults and lose every setting in it.
      const backup = `${configFile}.broken-${Date.now()}`;
      try {
        fs.copyFileSync(configFile, backup);
      } catch {
        /* best effort */
      }
      log.error(`failed to parse ${configFile} (saved a copy to ${backup}), using defaults:`, err);
      current = structuredClone(defaultConfig);
    }
  } else {
    current = structuredClone(defaultConfig);
    saveConfig(current);
    log.info(`wrote starter config to ${configFile}`);
  }
  return current;
}

function saveConfig(config: BotConfig): void {
  ensureDataDir();
  const tmp = path.join(path.dirname(configFile), `.config.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), "utf8");
  fs.renameSync(tmp, configFile);
}

export function getConfig(): BotConfig {
  return current;
}

/** Apply a partial update, persist it, and notify listeners. Returns the new config. */
export function updateConfig(patch: unknown): BotConfig {
  const previous = current;
  const next = sanitize(merge(structuredClone(current), patch));
  current = next;
  saveConfig(next);
  for (const listener of listeners) {
    try {
      listener(next, previous);
    } catch (err) {
      log.error("config listener failed:", err);
    }
  }
  return next;
}

export function onConfigChange(listener: Listener): void {
  listeners.add(listener);
}
