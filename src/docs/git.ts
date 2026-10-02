import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";

const exec = promisify(execFile);
const log = createLogger("git");

export interface RepoStatus {
  cloned: boolean;
  commit: string | null;
  commitMessage: string | null;
  commitDate: string | null;
  branch: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
}

/** Hide credentials embedded in any URL within the text — works on whole messages, not just bare URLs. */
export function redactUrl(text: string): string {
  return text.replace(/\/\/[^@/\s]+@/g, "//***@");
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (err) {
    // execFile errors embed the full command line, which includes a token if the
    // repo URL carries one. Rethrow redacted so it can't reach logs or the panel.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactUrl(message));
  }
}

/**
 * Clone the repo if missing, otherwise fetch and hard-reset to the remote branch.
 * The working tree is treated as disposable — local edits are discarded.
 */
export async function syncRepo(repoUrl: string, branch: string, dir: string): Promise<void> {
  const parent = path.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });

  if (fs.existsSync(path.join(dir, ".git"))) {
    const currentRemote = await git(dir, ["remote", "get-url", "origin"]).catch(() => "");
    if (currentRemote === repoUrl) {
      // Explicit refspec: a `--branch` clone only tracks that one branch, so a bare
      // `fetch origin <other>` never creates origin/<other> and a branch change in
      // the panel would fail with "origin/<branch> is not a commit".
      await git(dir, ["fetch", "--depth", "1", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      await git(dir, ["checkout", "--force", "-B", branch, `origin/${branch}`]);
      await git(dir, ["clean", "-fd"]);
      return;
    }
    // A different repository: start clean rather than grafting unrelated shallow history onto this one.
    log.info("repository URL changed — re-cloning");
  }

  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  log.info(`cloning ${redactUrl(repoUrl)} (${branch})`);
  // `--` stops git reading a URL that starts with "-" as an option (e.g. --upload-pack).
  await git(parent, ["clone", "--depth", "1", "--branch", branch, "--", repoUrl, dir]);
}

export async function readStatus(dir: string): Promise<Partial<RepoStatus>> {
  if (!fs.existsSync(path.join(dir, ".git"))) return { cloned: false };
  try {
    const line = await git(dir, ["log", "-1", "--format=%H%n%s%n%cI"]);
    const [commit, commitMessage, commitDate] = line.split("\n");
    const branch = await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => null);
    return {
      cloned: true,
      commit: commit ?? null,
      commitMessage: commitMessage ?? null,
      commitDate: commitDate ?? null,
      branch,
    };
  } catch (err) {
    log.warn("could not read repo status:", err);
    return { cloned: true };
  }
}
