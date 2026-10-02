import fs from "node:fs";
import { ensureDataDir, usageFile } from "../paths.js";
import { createLogger } from "../logger.js";

const log = createLogger("usage");

export interface UsageRecord {
  ts: number;
  userId: string;
  userName: string;
  guildId: string | null;
  channelId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  toolCalls: number;
  durationMs: number;
  ok: boolean;
}

let cache: UsageRecord[] | null = null;

function load(): UsageRecord[] {
  if (cache) return cache;
  ensureDataDir();
  if (!fs.existsSync(usageFile)) {
    cache = [];
    return cache;
  }
  const records: UsageRecord[] = [];
  for (const line of fs.readFileSync(usageFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as UsageRecord);
    } catch {
      // Skip a torn line rather than losing the whole log.
    }
  }
  cache = records;
  log.info(`loaded ${records.length} usage records`);
  return cache;
}

export function recordUsage(record: UsageRecord): void {
  ensureDataDir();
  load().push(record);
  try {
    fs.appendFileSync(usageFile, `${JSON.stringify(record)}\n`, "utf8");
  } catch (err) {
    log.error("failed to append usage record:", err);
  }
}

export interface UsageTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  costUsd: number;
  avgDurationMs: number;
}

function totalsOf(records: UsageRecord[]): UsageTotals {
  const totals: UsageTotals = {
    requests: records.length,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    costUsd: 0,
    avgDurationMs: 0,
  };
  let durationSum = 0;
  for (const r of records) {
    if (!r.ok) totals.errors++;
    totals.inputTokens += r.inputTokens;
    totals.outputTokens += r.outputTokens;
    totals.cacheCreationInputTokens += r.cacheCreationInputTokens;
    totals.cacheReadInputTokens += r.cacheReadInputTokens;
    totals.costUsd += r.costUsd;
    durationSum += r.durationMs;
  }
  totals.avgDurationMs = records.length ? Math.round(durationSum / records.length) : 0;
  return totals;
}

/**
 * YYYY-MM-DD in local time. The daily cost limit resets at local midnight, so the
 * chart's days must too — UTC buckets would disagree with it by up to a day.
 */
function localDate(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function costSince(since: number): number {
  return load().reduce((sum, r) => (r.ts >= since ? sum + r.costUsd : sum), 0);
}

export function costToday(): number {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  return costSince(start.getTime());
}

export interface UsageSummary {
  windowDays: number;
  totals: UsageTotals;
  daily: { date: string; requests: number; costUsd: number; inputTokens: number; outputTokens: number }[];
  byModel: { model: string; requests: number; costUsd: number }[];
  byUser: { userId: string; userName: string; requests: number; costUsd: number }[];
  byChannel: { channelId: string; requests: number; costUsd: number }[];
  recent: UsageRecord[];
}

export function summarize(days = 30): UsageSummary {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const records = load().filter((r) => r.ts >= since);

  const daily = new Map<string, { requests: number; costUsd: number; inputTokens: number; outputTokens: number }>();
  const byModel = new Map<string, { requests: number; costUsd: number }>();
  const byUser = new Map<string, { userName: string; requests: number; costUsd: number }>();
  const byChannel = new Map<string, { requests: number; costUsd: number }>();

  for (const r of records) {
    const date = localDate(r.ts);
    const d = daily.get(date) ?? { requests: 0, costUsd: 0, inputTokens: 0, outputTokens: 0 };
    d.requests++;
    d.costUsd += r.costUsd;
    d.inputTokens += r.inputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens;
    d.outputTokens += r.outputTokens;
    daily.set(date, d);

    const m = byModel.get(r.model) ?? { requests: 0, costUsd: 0 };
    m.requests++;
    m.costUsd += r.costUsd;
    byModel.set(r.model, m);

    const u = byUser.get(r.userId) ?? { userName: r.userName, requests: 0, costUsd: 0 };
    u.requests++;
    u.costUsd += r.costUsd;
    u.userName = r.userName || u.userName;
    byUser.set(r.userId, u);

    const c = byChannel.get(r.channelId) ?? { requests: 0, costUsd: 0 };
    c.requests++;
    c.costUsd += r.costUsd;
    byChannel.set(r.channelId, c);
  }

  return {
    windowDays: days,
    totals: totalsOf(records),
    daily: [...daily.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date)),
    byModel: [...byModel.entries()].map(([model, v]) => ({ model, ...v })).sort((a, b) => b.costUsd - a.costUsd),
    byUser: [...byUser.entries()]
      .map(([userId, v]) => ({ userId, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 25),
    byChannel: [...byChannel.entries()]
      .map(([channelId, v]) => ({ channelId, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd)
      .slice(0, 25),
    recent: records.slice(-50).reverse(),
  };
}

/** Requests by one user within the trailing window, for rate limiting. */
export function requestsByUserSince(userId: string, since: number): number {
  return load().reduce((count, r) => (r.userId === userId && r.ts >= since ? count + 1 : count), 0);
}
