import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import { ensureDataDir, modelsCacheFile } from "../paths.js";
import { getClient, hasCredentials } from "./client.js";
import { CACHE_WRITE_MULTIPLIER, modelFamily, pricingFor } from "./pricing.js";

const log = createLogger("models");

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export const EFFORT_LEVELS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

export const DEFAULT_MODEL = "claude-opus-5";

/** A model as the rest of the app sees it: API capabilities merged with local pricing. */
export interface ModelInfo {
  id: string;
  label: string;
  family: string;
  createdAt: string | null;
  inputPerMTok: number;
  outputPerMTok: number;
  /** Price inferred from the model family rather than a published rate. */
  pricingEstimated: boolean;
  contextTokens: number | null;
  maxOutputTokens: number;
  /** Effort levels this model accepts, lowest first. Empty = no effort parameter. */
  efforts: Effort[];
  supportsEffort: boolean;
  supportsAdaptiveThinking: boolean;
  /** Newest model in its family (Opus, Sonnet, ...) on this account. */
  latestInFamily: boolean;
  /** False when synthesized for an id that isn't in the catalog. */
  listed: boolean;
}

export interface CatalogStatus {
  /** Where the current list came from. */
  source: "api" | "cache" | "builtin";
  fetchedAt: number | null;
  lastError: string | null;
  refreshing: boolean;
}

/** The subset of the Models API response we keep — also the on-disk cache format. */
interface RawModel {
  id: string;
  display_name: string;
  created_at: string;
  max_input_tokens: number | null;
  max_tokens: number | null;
  /** Kept untyped: read with flag() so a new or missing capability can't throw. */
  capabilities: unknown;
}

// Used only until the first cache load or API fetch — e.g. before an API key is set.
const allEfforts = { supported: true, low: on(), medium: on(), high: on(), xhigh: on(), max: on() };
const BUILTIN: RawModel[] = [
  builtin("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000, allEfforts, true),
  builtin("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 128_000, allEfforts, true),
  builtin("claude-fable-5-1", "Claude Fable 5.1", 1_000_000, 128_000, allEfforts, true),
  builtin("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000, allEfforts, true),
  builtin("claude-sonnet-5", "Claude Sonnet 5", 1_000_000, 128_000, allEfforts, true),
  builtin("claude-opus-4-8", "Claude Opus 4.8", 1_000_000, 128_000, allEfforts, true),
  builtin(
    "claude-sonnet-4-6",
    "Claude Sonnet 4.6",
    1_000_000,
    128_000,
    { ...allEfforts, xhigh: null },
    true,
  ),
  builtin("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000, { supported: false }, false),
];

function on() {
  return { supported: true };
}

function builtin(
  id: string,
  name: string,
  context: number,
  maxOut: number,
  effort: object,
  adaptive: boolean,
): RawModel {
  return {
    id,
    display_name: name,
    created_at: "1970-01-01T00:00:00Z",
    max_input_tokens: context,
    max_tokens: maxOut,
    capabilities: { effort, thinking: { supported: true, types: { adaptive: { supported: adaptive } } } },
  };
}

let catalog: ModelInfo[] = [];
const status: CatalogStatus = { source: "builtin", fetchedAt: null, lastError: null, refreshing: false };
apply(BUILTIN, "builtin", null);

/** Read a boolean at a nested path, treating anything unexpected as false. */
function flag(obj: unknown, ...keys: string[]): boolean {
  let cursor: unknown = obj;
  for (const key of keys) {
    if (cursor === null || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor === true;
}

function shape(raw: RawModel): ModelInfo {
  const caps = raw.capabilities;
  const efforts = flag(caps, "effort", "supported")
    ? EFFORT_LEVELS.filter((level) => flag(caps, "effort", level, "supported"))
    : [];
  const pricing = pricingFor(raw.id);
  const created = Date.parse(raw.created_at);
  return {
    id: raw.id,
    label: raw.display_name || raw.id,
    family: modelFamily(raw.id),
    // The API sends an epoch date when the release date is unknown.
    createdAt: Number.isFinite(created) && created > 0 ? raw.created_at : null,
    inputPerMTok: pricing.inputPerMTok,
    outputPerMTok: pricing.outputPerMTok,
    pricingEstimated: pricing.estimated,
    contextTokens: raw.max_input_tokens,
    maxOutputTokens: raw.max_tokens ?? 8192,
    efforts,
    supportsEffort: efforts.length > 0,
    supportsAdaptiveThinking: flag(caps, "thinking", "types", "adaptive", "supported"),
    latestInFamily: false,
    listed: true,
  };
}

function apply(raws: RawModel[], source: CatalogStatus["source"], fetchedAt: number | null): void {
  const shaped = raws.map(shape);
  // Newest first; Array.prototype.sort is stable, so undated entries keep their order.
  shaped.sort((a, b) => (b.createdAt ? Date.parse(b.createdAt) : 0) - (a.createdAt ? Date.parse(a.createdAt) : 0));

  const seenFamilies = new Set<string>();
  for (const model of shaped) {
    if (model.family !== "other" && !seenFamilies.has(model.family)) {
      model.latestInFamily = true;
      seenFamilies.add(model.family);
    }
  }

  catalog = shaped;
  status.source = source;
  status.fetchedAt = fetchedAt;
}

/** Load the last successful fetch from disk. Synchronous so it's ready before config validation. */
export function loadCachedCatalog(): void {
  if (!fs.existsSync(modelsCacheFile)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(modelsCacheFile, "utf8")) as {
      fetchedAt?: number;
      models?: RawModel[];
    };
    if (Array.isArray(parsed.models) && parsed.models.length > 0) {
      apply(parsed.models, "cache", parsed.fetchedAt ?? null);
      log.info(`loaded ${parsed.models.length} models from cache`);
    }
  } catch (err) {
    log.warn("ignoring unreadable model cache:", err);
  }
}

function saveCache(raws: RawModel[], fetchedAt: number): void {
  try {
    ensureDataDir();
    const tmp = path.join(path.dirname(modelsCacheFile), `.models-cache.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ fetchedAt, models: raws }, null, 2), "utf8");
    fs.renameSync(tmp, modelsCacheFile);
  } catch (err) {
    log.warn("failed to write model cache:", err);
  }
}

let inflight: Promise<void> | null = null;

/** Fetch the account's model list from the Models API. Concurrent calls share one request. */
export function refreshCatalog(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    status.refreshing = true;
    try {
      if (!hasCredentials()) throw new Error("no Anthropic API key configured");
      const raws: RawModel[] = [];
      for await (const model of getClient().models.list()) {
        raws.push({
          id: model.id,
          display_name: model.display_name,
          created_at: model.created_at,
          max_input_tokens: model.max_input_tokens ?? null,
          max_tokens: model.max_tokens ?? null,
          capabilities: model.capabilities ?? null,
        });
      }
      if (raws.length === 0) throw new Error("the Models API returned an empty list");

      const fetchedAt = Date.now();
      apply(raws, "api", fetchedAt);
      saveCache(raws, fetchedAt);
      status.lastError = null;
      log.info(`model list refreshed from the API: ${raws.length} models`);
    } catch (err) {
      status.lastError = err instanceof Error ? err.message : String(err);
      log.warn(`model list refresh failed (keeping the ${status.source} list):`, status.lastError);
      throw err;
    } finally {
      status.refreshing = false;
      inflight = null;
    }
  })();
  return inflight;
}

export function listModels(): ModelInfo[] {
  return catalog;
}

export function catalogStatus(): CatalogStatus {
  return status;
}

export function isListed(id: string): boolean {
  return catalog.some((m) => m.id === id);
}

/**
 * Look up a model. An id that isn't in the catalog (e.g. set before the list
 * loaded, or since retired) gets a conservative profile — no effort, no explicit
 * thinking config — which every model accepts.
 */
export function getModel(id: string): ModelInfo {
  const found = catalog.find((m) => m.id === id);
  if (found) return found;
  const pricing = pricingFor(id);
  return {
    id,
    label: id,
    family: modelFamily(id),
    createdAt: null,
    inputPerMTok: pricing.inputPerMTok,
    outputPerMTok: pricing.outputPerMTok,
    pricingEstimated: pricing.estimated,
    contextTokens: null,
    maxOutputTokens: 8192,
    efforts: [],
    supportsEffort: false,
    supportsAdaptiveThinking: false,
    latestInFamily: false,
    listed: false,
  };
}

/**
 * The effort level to actually send. If the configured level isn't supported by
 * this model (e.g. "xhigh" on a model without it), step down to the nearest lower
 * supported level, then up. Null means omit the parameter entirely.
 */
export function effectiveEffort(requested: Effort, model: ModelInfo): Effort | null {
  if (!model.supportsEffort) return null;
  if (model.efforts.includes(requested)) return requested;
  const index = EFFORT_LEVELS.indexOf(requested);
  for (let i = index - 1; i >= 0; i--) {
    if (model.efforts.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]!;
  }
  for (let i = index + 1; i < EFFORT_LEVELS.length; i++) {
    if (model.efforts.includes(EFFORT_LEVELS[i]!)) return EFFORT_LEVELS[i]!;
  }
  return null;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

/**
 * Cost in USD. Cache writes bill at 1.25x the input rate (5-minute TTL); cache
 * reads at a per-model fraction (0.1x on most, lower on some newer models).
 * Works for any model id, listed or not.
 */
export function costOf(modelId: string, usage: TokenUsage): number {
  const pricing = pricingFor(modelId);
  const inRate = pricing.inputPerMTok / 1_000_000;
  const outRate = pricing.outputPerMTok / 1_000_000;
  return (
    usage.inputTokens * inRate +
    usage.cacheCreationInputTokens * inRate * CACHE_WRITE_MULTIPLIER +
    usage.cacheReadInputTokens * inRate * pricing.cacheReadMultiplier +
    usage.outputTokens * outRate
  );
}

export function addUsage(target: TokenUsage, delta: Partial<TokenUsage>): void {
  target.inputTokens += delta.inputTokens ?? 0;
  target.outputTokens += delta.outputTokens ?? 0;
  target.cacheCreationInputTokens += delta.cacheCreationInputTokens ?? 0;
  target.cacheReadInputTokens += delta.cacheReadInputTokens ?? 0;
}
