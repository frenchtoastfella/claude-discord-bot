import Anthropic from "@anthropic-ai/sdk";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  cleanContent,
  type Message,
} from "discord.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { AgentError, runAgent } from "../claude/agent.js";
import { emptyUsage, getModel, type TokenUsage } from "../claude/models.js";
import type { ToolContext } from "../claude/tools.js";
import { appendExchange, getHistory } from "../store/conversations.js";
import { costToday, recordUsage, requestsByUserSince } from "../store/usage.js";
import { StreamingReply } from "./responder.js";
import { buildServerSnapshot, type ServerSnapshot } from "./server-context.js";

const log = createLogger("discord");

export interface BotStatus {
  connected: boolean;
  username: string | null;
  userId: string | null;
  /** OAuth client id — needed to build the server invite URL. */
  applicationId: string | null;
  guilds: { id: string; name: string; memberCount: number }[];
  readyAt: number | null;
  activeRequests: number;
  lastError: string | null;
}

const status: BotStatus = {
  connected: false,
  username: null,
  userId: null,
  applicationId: null,
  guilds: [],
  readyAt: null,
  activeRequests: 0,
  lastError: null,
};

let client: Client | null = null;
/** Channels with a request in flight — prevents interleaved answers in one channel. */
const busyChannels = new Set<string>();

export function getBotStatus(): BotStatus {
  if (client?.isReady()) {
    status.guilds = [...client.guilds.cache.values()].map((g) => ({
      id: g.id,
      name: g.name,
      memberCount: g.memberCount,
    }));
  }
  return status;
}

export async function startBot(token: string): Promise<Client> {
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once(Events.ClientReady, (ready) => {
    status.connected = true;
    status.username = ready.user.tag;
    status.userId = ready.user.id;
    status.applicationId = ready.application?.id ?? ready.user.id;
    status.readyAt = Date.now();
    status.lastError = null;
    log.info(`logged in as ${ready.user.tag} in ${ready.guilds.cache.size} guild(s)`);
  });

  client.on(Events.Error, (err) => {
    status.lastError = err.message;
    log.error("gateway error:", err);
  });

  client.on(Events.MessageCreate, (message) => {
    handleMessage(message).catch((err) => log.error("message handler failed:", err));
  });

  await client.login(token);
  return client;
}

export async function stopBot(): Promise<void> {
  if (client) {
    await client.destroy();
    client = null;
  }
  status.connected = false;
}

/** Decide whether this message is addressed to the bot. */
function shouldRespond(message: Message): boolean {
  const cfg = getConfig().discord;
  const me = client?.user;
  if (!me) return false;
  if (message.author.bot) return false;
  if (cfg.blockedUserIds.includes(message.author.id)) return false;

  const isDM = message.channel.type === ChannelType.DM;
  if (isDM) return cfg.respondToDMs;

  if (cfg.allowedGuildIds.length > 0 && (!message.guildId || !cfg.allowedGuildIds.includes(message.guildId))) {
    return false;
  }
  if (isAlwaysRespondChannel(message, cfg.alwaysRespondChannelIds)) return true;
  // Discord's autocomplete often offers the bot's *role* (@BotName) above the bot
  // user, and picking it produces a role mention — count that as addressing us too.
  const botRoleId = botRoleIdIn(message);
  if (
    cfg.respondToMentions &&
    (message.mentions.users.has(me.id) || (botRoleId !== null && message.mentions.roles.has(botRoleId)))
  ) {
    return true;
  }
  if (
    cfg.respondToReplies &&
    message.reference?.messageId &&
    message.mentions.repliedUser?.id === me.id
  ) {
    return true;
  }
  return false;
}

/**
 * Match an always-answer entry against a channel. Accepts either a numeric channel
 * id or a channel name (with or without a leading '#') — copying a name out of
 * Discord is the obvious thing to do, and requiring Developer Mode just to find an
 * id is a papercut. Threads also match on their parent channel.
 */
function isAlwaysRespondChannel(message: Message, entries: string[]): boolean {
  if (entries.length === 0) return false;
  const wanted = new Set(entries.map((e) => e.replace(/^#/, "").toLowerCase()));

  if (wanted.has(message.channelId)) return true;

  const channel = message.channel;
  if ("name" in channel && typeof channel.name === "string" && wanted.has(channel.name.toLowerCase())) {
    return true;
  }
  if (channel.isThread()) {
    if (channel.parentId && wanted.has(channel.parentId)) return true;
    const parentName = channel.parent?.name;
    if (parentName && wanted.has(parentName.toLowerCase())) return true;
  }
  return false;
}

function botRoleIdIn(message: Message): string | null {
  return message.guild?.members.me?.roles.botRole?.id ?? null;
}

/**
 * Strip mentions of the bot itself, then turn the remaining raw mentions into
 * names. Discord sends "what is <#1234> for?" — without this Claude sees an
 * opaque id it can't match against list_channels / list_roles output.
 */
function extractQuestion(message: Message): string {
  const me = client?.user;
  let text = message.content;
  if (me) text = text.replaceAll(`<@${me.id}>`, "").replaceAll(`<@!${me.id}>`, "");
  const botRoleId = botRoleIdIn(message);
  if (botRoleId) text = text.replaceAll(`<@&${botRoleId}>`, "");
  return cleanContent(text, message.channel).trim();
}

function channelLabel(message: Message): string {
  if (message.channel.type === ChannelType.DM) return `DM with ${message.author.tag}`;
  const name = "name" in message.channel ? message.channel.name : message.channelId;
  return message.guild ? `#${name} (${message.guild.name})` : `#${name}`;
}

async function handleMessage(message: Message): Promise<void> {
  if (!shouldRespond(message)) return;

  const cfg = getConfig();
  const question = extractQuestion(message);
  if (!question) {
    await message.reply({
      content: "Ask me something about the docs and I'll look it up.",
      allowedMentions: { repliedUser: false, parse: [] },
    });
    return;
  }

  if (busyChannels.has(message.channelId)) {
    await message.react("⏳").catch(() => {});
    return;
  }

  // Guardrails before spending anything.
  const hourly = cfg.limits.maxRequestsPerUserPerHour;
  if (hourly > 0 && requestsByUserSince(message.author.id, Date.now() - 3_600_000) >= hourly) {
    await message.reply({
      content: `You've hit the limit of ${hourly} requests per hour. Try again later.`,
      allowedMentions: { repliedUser: false, parse: [] },
    });
    return;
  }
  if (cfg.limits.dailyCostLimitUsd > 0 && costToday() >= cfg.limits.dailyCostLimitUsd) {
    await message.reply({
      content: "I've hit today's spending limit. An admin can raise it in the admin panel.",
      allowedMentions: { repliedUser: false, parse: [] },
    });
    return;
  }

  busyChannels.add(message.channelId);
  status.activeRequests++;
  const started = Date.now();
  const reply = new StreamingReply(message.channel, message);

  let statusLine = "";
  let answerText = "";
  const showActivity = cfg.discord.showToolActivity;

  const paint = () => {
    if (answerText) reply.update(answerText);
    else if (statusLine) reply.update(`_${statusLine}_`);
  };

  // Built only if Claude actually calls a server tool — walking every channel's
  // permissions is wasted work on the many questions that never need it.
  let snapshot: ServerSnapshot | null | undefined;
  const toolContext: ToolContext = {
    get server() {
      if (snapshot === undefined) snapshot = buildServerSnapshot(message);
      return snapshot;
    },
  };

  const recordRun = (ok: boolean, model: string, usage: TokenUsage, costUsd: number, toolCalls: number) =>
    recordUsage({
      ts: started,
      userId: message.author.id,
      userName: message.author.tag,
      guildId: message.guildId,
      channelId: message.channelId,
      model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      costUsd,
      toolCalls,
      durationMs: Date.now() - started,
      ok,
    });

  try {
    await reply.start();
    if ("sendTyping" in message.channel) void message.channel.sendTyping().catch(() => {});

    const result = await runAgent(
      question,
      getHistory(message.channelId),
      {
        onText: (text) => {
          answerText = text;
          paint();
        },
        onToolStart: (summary) => {
          if (!showActivity) return;
          statusLine = summary;
          paint();
        },
        onToolEnd: (summary) => {
          if (!showActivity) return;
          statusLine = summary;
          paint();
        },
      },
      toolContext,
    );

    let finalText = result.text || "_I couldn't produce an answer for that._";
    if (result.warning) finalText += `\n\n_⚠️ ${result.warning}_`;
    if (cfg.discord.showUsageFooter) finalText += `\n${usageFooter(result)}`;

    await reply.finish(finalText);

    if (result.text) {
      appendExchange(message.channelId, channelLabel(message), question, result.text);
    }

    recordRun(true, result.model, result.usage, result.costUsd, result.toolCalls);

    log.info(
      `answered ${message.author.tag} in ${channelLabel(message)} — ${result.toolCalls} tool call(s), ` +
        `${(result.durationMs / 1000).toFixed(1)}s, $${result.costUsd.toFixed(4)}`,
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error("agent run failed:", detail);
    status.lastError = detail;
    // The raw error goes to the log and the panel; the channel gets something
    // readable that doesn't dump API internals in front of everyone.
    await reply.finish(`⚠️ ${friendlyError(err)}`).catch(() => {});

    // Tokens spent before the failure are still billed — record them so the
    // dashboard and the daily cost limit don't undercount.
    if (err instanceof AgentError) recordRun(false, err.model, err.usage, err.costUsd, err.toolCalls);
    else recordRun(false, cfg.model, emptyUsage(), 0, 0);
  } finally {
    busyChannels.delete(message.channelId);
    status.activeRequests--;
  }
}

/** Map API failures to something a Discord user can act on. */
function friendlyError(err: unknown): string {
  const cause = err instanceof AgentError ? err.cause : err;
  if (cause instanceof Anthropic.RateLimitError) return "I'm being rate-limited right now. Try again in a minute.";
  if (cause instanceof Anthropic.AuthenticationError || cause instanceof Anthropic.PermissionDeniedError) {
    return "My Anthropic API key was rejected. An admin needs to check it.";
  }
  if (cause instanceof Anthropic.NotFoundError) {
    return "The configured model isn't available. An admin should pick another one in the admin panel.";
  }
  if (cause instanceof Anthropic.APIConnectionError) return "I couldn't reach Claude. Try again shortly.";
  if (cause instanceof Anthropic.APIError && (cause.status === 529 || (cause.status ?? 0) >= 500)) {
    return "Claude is overloaded or having trouble right now. Try again shortly.";
  }
  return "Something went wrong answering that. The details are in the bot's log.";
}

function usageFooter(result: {
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
  costUsd: number;
  durationMs: number;
  toolCalls: number;
}): string {
  const label = getModel(result.model).label;
  const cached = result.usage.cacheReadInputTokens;
  const parts = [
    label,
    `${result.toolCalls} tool call${result.toolCalls === 1 ? "" : "s"}`,
    `${(result.durationMs / 1000).toFixed(1)}s`,
    `$${result.costUsd.toFixed(4)}`,
  ];
  if (cached > 0) parts.push(`${(cached / 1000).toFixed(1)}k cached`);
  return `-# ${parts.join(" · ")}`;
}
