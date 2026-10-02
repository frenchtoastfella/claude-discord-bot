import fs from "node:fs";
import path from "node:path";
import { createLogger } from "../logger.js";
import { docsRepoDir } from "../paths.js";
import { getConfig } from "../config.js";
import { readStatus, redactUrl, syncRepo, type RepoStatus } from "./git.js";

const log = createLogger("docs");

const MAX_FILE_BYTES = 1_000_000;
const MAX_TOTAL_CACHE_BYTES = 64 * 1024 * 1024;

export interface DocFile {
  /** Path relative to the indexed root, always forward-slashed. */
  path: string;
  title: string;
  bytes: number;
  lines: number;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  matches: { line: number; text: string }[];
}

/** Translate a glob (supporting **, *, ?) into an anchored RegExp. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        // "**/" should also match zero directories.
        if (glob[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

function matchesAny(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(relPath));
}

function extractTitle(relPath: string, content: string): string {
  const heading = content.match(/^\s{0,3}#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim().slice(0, 120);
  const front = content.match(/^---\r?\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m);
  if (front?.[1]) return front[1].trim().slice(0, 120);
  return path.basename(relPath).replace(/\.[^.]+$/, "");
}

interface CachedContent {
  text: string;
  /** Lowercased once, so search doesn't re-lowercase the whole corpus on every query. */
  lower: string;
}

export class DocsIndex {
  private files: DocFile[] = [];
  private contents = new Map<string, CachedContent>();
  private cachedBytes = 0;
  private root = docsRepoDir;
  /** Serializes syncs; `queued` is the one waiting behind the running sync, if any. */
  private chain: Promise<void> = Promise.resolve();
  private queued: Promise<void> | null = null;
  private queuedPull = false;

  status: RepoStatus = {
    cloned: false,
    commit: null,
    commitMessage: null,
    commitDate: null,
    branch: null,
    lastSyncAt: null,
    lastError: null,
  };

  /** Bumped whenever the indexed content changes; used to invalidate the prompt cache. */
  version = 0;
  indexedAt: number | null = null;
  syncing = false;

  get fileCount(): number {
    return this.files.length;
  }

  get totalBytes(): number {
    return this.files.reduce((sum, f) => sum + f.bytes, 0);
  }

  get ready(): boolean {
    return this.files.length > 0;
  }

  private indexRoot(): string {
    const { subdir } = getConfig().docs;
    return subdir ? path.join(this.root, subdir) : this.root;
  }

  /**
   * Pull the repo (if configured) and rebuild the index.
   *
   * Calls made while a sync is running are coalesced into one follow-up sync, not
   * dropped: changing the repo URL in the panel mid-pull must still take effect,
   * but ten quick saves shouldn't mean ten pulls.
   */
  sync(options: { pull?: boolean } = {}): Promise<void> {
    const pull = options.pull !== false;
    if (this.queued) {
      this.queuedPull ||= pull;
      return this.queued;
    }
    this.queuedPull = pull;
    const run = this.chain.then(() => {
      this.queued = null;
      return this.runSync(this.queuedPull);
    });
    this.queued = run;
    this.chain = run.catch(() => {});
    return run;
  }

  private async runSync(pull: boolean): Promise<void> {
    this.syncing = true;
    const cfg = getConfig();
    try {
      if (!cfg.docs.repoUrl) {
        // Repo removed in the panel: forget the old clone's status and contents.
        Object.assign(this.status, { cloned: false, commit: null, commitMessage: null, commitDate: null, branch: null });
      } else {
        if (pull) await syncRepo(cfg.docs.repoUrl, cfg.docs.branch, this.root);
        Object.assign(this.status, await readStatus(this.root));
      }
      this.status.lastError = null;
      this.status.lastSyncAt = Date.now();
      this.rebuild();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.status.lastError = message;
      log.error("docs sync failed:", message);
      throw err;
    } finally {
      this.syncing = false;
    }
  }

  private clear(): void {
    this.files = [];
    this.contents.clear();
    this.cachedBytes = 0;
    this.indexedAt = Date.now();
    this.version++;
  }

  private remember(relPath: string, text: string): void {
    // Two copies are held (original + lowercased), so count both against the cap.
    if (this.cachedBytes + text.length * 2 >= MAX_TOTAL_CACHE_BYTES) return;
    this.contents.set(relPath, { text, lower: text.toLowerCase() });
    this.cachedBytes += text.length * 2;
  }

  /** Walk the working tree and rebuild the file list. */
  rebuild(): void {
    const cfg = getConfig().docs;
    // No repo configured means no docs — even if an old clone is still on disk.
    // Otherwise removing the repo URL would leave the bot answering from it forever.
    if (!cfg.repoUrl) {
      this.clear();
      return;
    }
    const root = this.indexRoot();
    if (!fs.existsSync(root)) {
      log.warn(`index root does not exist: ${root}`);
      this.clear();
      return;
    }
    this.contents.clear();
    this.cachedBytes = 0;

    const include = cfg.includeGlobs.map(globToRegExp);
    const exclude = cfg.excludeGlobs.map(globToRegExp);
    const found: DocFile[] = [];

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        const rel = path.relative(root, abs).split(path.sep).join("/");
        if (entry.isDirectory()) {
          if (entry.name === ".git") continue;
          if (matchesAny(`${rel}/`, exclude) || matchesAny(rel, exclude)) continue;
          walk(abs);
          continue;
        }
        if (!entry.isFile()) continue;
        if (matchesAny(rel, exclude)) continue;
        if (!matchesAny(rel, include)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) {
          log.debug(`skipping oversized file ${rel} (${stat.size} bytes)`);
          continue;
        }
        let content: string;
        try {
          content = normalizeText(fs.readFileSync(abs, "utf8"));
        } catch {
          continue;
        }
        // Already read to get the title — keep it rather than reading again on the first search.
        this.remember(rel, content);
        found.push({
          path: rel,
          title: extractTitle(rel, content),
          bytes: stat.size,
          lines: content.split("\n").length,
        });
      }
    };

    walk(root);
    found.sort((a, b) => a.path.localeCompare(b.path));

    this.files = found;
    this.indexedAt = Date.now();
    this.version++;
    log.info(`indexed ${found.length} files from ${root}`);
  }

  list(prefix = ""): DocFile[] {
    const normalized = prefix.replace(/^[./]+/, "").replace(/\/+$/, "");
    if (!normalized) return this.files;
    return this.files.filter((f) => f.path === normalized || f.path.startsWith(`${normalized}/`));
  }

  private contentOf(relPath: string): CachedContent | null {
    const cached = this.contents.get(relPath);
    if (cached !== undefined) return cached;
    const abs = path.join(this.indexRoot(), relPath);
    try {
      const text = normalizeText(fs.readFileSync(abs, "utf8"));
      this.remember(relPath, text);
      return this.contents.get(relPath) ?? { text, lower: text.toLowerCase() };
    } catch {
      return null;
    }
  }

  /**
   * Keyword search. Scores files by term frequency with a boost for hits in the
   * path/title, and returns the best-matching lines from each file.
   */
  search(query: string, options: { maxResults?: number; pathPrefix?: string } = {}): SearchHit[] {
    const maxResults = Math.min(Math.max(options.maxResults ?? 6, 1), 20);
    const terms = [
      ...new Set(
        query
          .toLowerCase()
          .split(/[^a-z0-9_.\-/@]+/i)
          .map((t) => t.trim())
          .filter((t) => t.length >= 2 && !STOP_WORDS.has(t)),
      ),
    ];
    if (terms.length === 0) return [];

    const candidates = this.list(options.pathPrefix ?? "");
    const scored: { file: DocFile; content: CachedContent; score: number }[] = [];

    for (const file of candidates) {
      const content = this.contentOf(file.path);
      if (content === null) continue;
      const haystack = content.lower;
      const meta = `${file.path} ${file.title}`.toLowerCase();

      let score = 0;
      let matchedTerms = 0;
      for (const term of terms) {
        const count = countOccurrences(haystack, term);
        if (count > 0) matchedTerms++;
        score += Math.min(count, 25);
        if (meta.includes(term)) score += 12;
      }
      if (matchedTerms === 0) continue;
      // Reward files that cover more of the query.
      score *= 1 + matchedTerms / terms.length;

      scored.push({ file, content, score });
    }

    scored.sort((a, b) => b.score - a.score);
    // Snippet extraction splits the whole file into lines — only do it for the winners.
    return scored.slice(0, maxResults).map(({ file, content, score }) => ({
      path: file.path,
      title: file.title,
      score,
      matches: bestLines(content.text, terms, 4),
    }));
  }

  read(
    relPath: string,
    startLine?: number,
    endLine?: number,
  ): { path: string; content: string; totalLines: number; from: number; to: number } | null {
    const normalized = relPath.replace(/^[./]+/, "").split(path.sep).join("/");
    const known = this.files.find((f) => f.path === normalized);
    if (!known) return null;
    const content = this.contentOf(normalized);
    if (content === null) return null;

    const lines = content.text.split("\n");
    const from = Math.max(1, Math.floor(startLine ?? 1));
    const to = Math.min(lines.length, Math.floor(endLine ?? from + 399));
    const slice = lines.slice(from - 1, to);

    let text = slice.map((line, i) => `${from + i}\t${line}`).join("\n");
    if (text.length > 60_000) text = `${text.slice(0, 60_000)}\n… (truncated)`;

    return { path: normalized, content: text, totalLines: lines.length, from, to };
  }

  /**
   * A compact table of contents, embedded in the cached system prompt so Claude
   * knows what exists without searching first.
   */
  renderIndexForPrompt(): string {
    const cfg = getConfig();
    if (this.files.length === 0) {
      return cfg.docs.repoUrl
        ? "No documentation files are indexed yet (the repo may still be syncing)."
        : "No documentation repository is configured. Answer from general knowledge and say that project docs are unavailable.";
    }

    const limit = cfg.docs.maxIndexEntries;
    const shown = this.files.slice(0, limit);
    const lines = shown.map((f) => `- ${f.path} — ${f.title}`);
    if (this.files.length > limit) {
      lines.push(`- … and ${this.files.length - limit} more files (use list_docs to browse them)`);
    }
    const label = cfg.docs.subdir ? `${cfg.docs.repoUrl} (${cfg.docs.subdir}/)` : cfg.docs.repoUrl;
    return [
      `Documentation index — ${this.files.length} files from ${redactUrl(label)}`,
      this.status.commit ? `Revision: ${this.status.commit.slice(0, 8)} (${this.status.commitDate ?? "unknown date"})` : "",
      "",
      ...lines,
    ]
      .filter(Boolean)
      .join("\n");
  }
}

/**
 * Drop a BOM and convert CRLF to LF. Git on Windows checks docs out with CRLF by
 * default, and every stray \r would otherwise be shipped to Claude as a token.
 */
function normalizeText(text: string): string {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, "\n");
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1 && count < 200) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

function bestLines(content: string, terms: string[], limit: number): { line: number; text: string }[] {
  const lines = content.split("\n");
  const scored: { line: number; text: string; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const lower = raw.toLowerCase();
    let score = 0;
    for (const term of terms) if (lower.includes(term)) score += 1;
    if (score === 0) continue;
    scored.push({ line: i + 1, text: raw.trim().slice(0, 300), score });
  }
  scored.sort((a, b) => b.score - a.score || a.line - b.line);
  return scored.slice(0, limit).map(({ line, text }) => ({ line, text }));
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "how", "what", "why", "when",
  "does", "did", "can", "this", "that", "from", "have", "has", "was", "were", "will", "would",
  "there", "their", "about", "into", "any", "its", "our", "out", "get", "got",
]);

export const docsIndex = new DocsIndex();
