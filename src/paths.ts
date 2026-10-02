import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root: src/ during dev (tsx), dist/ after a build — both are one level down. */
export const projectRoot = path.resolve(here, "..");

export const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(projectRoot, "data");

export const configFile = path.join(dataDir, "config.json");
export const usageFile = path.join(dataDir, "usage.jsonl");
export const conversationsFile = path.join(dataDir, "conversations.json");
export const docsRepoDir = path.join(dataDir, "docs-repo");
export const modelsCacheFile = path.join(dataDir, "models-cache.json");

export function ensureDataDir(): void {
  fs.mkdirSync(dataDir, { recursive: true });
}
