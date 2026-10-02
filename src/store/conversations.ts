import fs from "node:fs";
import path from "node:path";
import { conversationsFile, ensureDataDir } from "../paths.js";
import { getConfig } from "../config.js";
import { createLogger } from "../logger.js";
import type { ConversationTurn } from "../claude/agent.js";

const log = createLogger("conversations");

interface Conversation {
  channelId: string;
  channelLabel: string;
  turns: ConversationTurn[];
  updatedAt: number;
}

const conversations = new Map<string, Conversation>();
let saveTimer: NodeJS.Timeout | null = null;

export function loadConversations(): void {
  ensureDataDir();
  if (!fs.existsSync(conversationsFile)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(conversationsFile, "utf8")) as Conversation[];
    for (const conv of raw) {
      if (conv?.channelId) conversations.set(conv.channelId, conv);
    }
    log.info(`restored ${conversations.size} conversations`);
    prune();
  } catch (err) {
    log.error("failed to load conversations:", err);
  }
}

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 3000);
  saveTimer.unref?.();
}

export function save(): void {
  try {
    ensureDataDir();
    const tmp = path.join(path.dirname(conversationsFile), `.conversations.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify([...conversations.values()], null, 2), "utf8");
    fs.renameSync(tmp, conversationsFile);
  } catch (err) {
    log.error("failed to save conversations:", err);
  }
}

/** Drop conversations that have gone quiet past the configured TTL. */
export function prune(): void {
  const ttlMs = getConfig().conversation.ttlMinutes * 60 * 1000;
  const cutoff = Date.now() - ttlMs;
  let removed = 0;
  for (const [id, conv] of conversations) {
    if (conv.updatedAt < cutoff) {
      conversations.delete(id);
      removed++;
    }
  }
  if (removed > 0) {
    log.debug(`pruned ${removed} idle conversations`);
    scheduleSave();
  }
}

export function getHistory(channelId: string): ConversationTurn[] {
  prune();
  const conv = conversations.get(channelId);
  if (!conv) return [];
  const maxTurns = getConfig().conversation.maxTurns;
  if (maxTurns === 0) return [];
  return conv.turns.slice(-maxTurns * 2);
}

export function appendExchange(
  channelId: string,
  channelLabel: string,
  userText: string,
  assistantText: string,
): void {
  const maxTurns = getConfig().conversation.maxTurns;
  if (maxTurns === 0) return;

  const conv = conversations.get(channelId) ?? {
    channelId,
    channelLabel,
    turns: [],
    updatedAt: Date.now(),
  };
  conv.channelLabel = channelLabel;
  conv.turns.push({ role: "user", content: userText });
  conv.turns.push({ role: "assistant", content: assistantText });
  // Keep a little slack over the replay window so trimming isn't lossy mid-turn.
  conv.turns = conv.turns.slice(-(maxTurns * 2 + 4));
  conv.updatedAt = Date.now();
  conversations.set(channelId, conv);
  scheduleSave();
}

export function clearConversation(channelId: string): boolean {
  const existed = conversations.delete(channelId);
  if (existed) scheduleSave();
  return existed;
}

export function clearAllConversations(): number {
  const count = conversations.size;
  conversations.clear();
  save();
  return count;
}

export function listConversations(): { channelId: string; channelLabel: string; turns: number; updatedAt: number }[] {
  return [...conversations.values()]
    .map((c) => ({
      channelId: c.channelId,
      channelLabel: c.channelLabel,
      turns: Math.floor(c.turns.length / 2),
      updatedAt: c.updatedAt,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
