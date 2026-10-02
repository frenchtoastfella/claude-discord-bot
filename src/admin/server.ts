import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import { defaultConfig, getConfig, updateConfig } from "../config.js";
import { createLogger, recentLogs } from "../logger.js";
import { projectRoot } from "../paths.js";
import { docsIndex } from "../docs/index.js";
import { redactUrl } from "../docs/git.js";
import { catalogStatus, getModel, isListed, listModels, refreshCatalog } from "../claude/models.js";
import { hasCredentials } from "../claude/client.js";
import { getBotStatus } from "../discord/bot.js";
import { costToday, summarize } from "../store/usage.js";
import {
  clearAllConversations,
  clearConversation,
  listConversations,
} from "../store/conversations.js";

const log = createLogger("admin");
const startedAt = Date.now();

/**
 * The first segment of a bot token is the base64url-encoded application id.
 * Lets the Setup tab build an invite URL even when the gateway login is failing —
 * which is exactly when someone needs it.
 */
function applicationIdFromToken(): string | null {
  const token = process.env.DISCORD_TOKEN?.trim();
  const head = token?.split(".")[0];
  if (!head) return null;
  try {
    const decoded = Buffer.from(head, "base64url").toString("utf8");
    return /^\d{17,20}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function publicDir(): string {
  const candidates = [
    path.join(projectRoot, "dist", "admin", "public"),
    path.join(projectRoot, "src", "admin", "public"),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) ?? candidates[1]!;
}

export function startAdminServer(port: number, token: string): Promise<void> {
  const app = express();

  // Binding to loopback keeps the network out, but not the browser: any page you
  // visit can send requests to 127.0.0.1. Two guards close that:
  //  - Host must be ours, which defeats DNS rebinding (attacker.com re-pointed at
  //    127.0.0.1 would otherwise be same-origin and could read the config, repo
  //    token included).
  //  - Cross-site state changes are refused. A plain cross-origin POST needs no CORS
  //    preflight, so without this a malicious page could hit /api/config/reset.
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((host) => `http://${host}`));
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!allowedHosts.has(req.headers.host ?? "")) {
      res.status(403).send("forbidden host");
      return;
    }
    const origin = req.headers.origin;
    if (req.method !== "GET" && req.method !== "HEAD" && origin && !allowedOrigins.has(origin)) {
      res.status(403).json({ error: "cross-origin request refused" });
      return;
    }
    next();
  });

  app.use(express.json({ limit: "1mb" }));

  // Loopback-only by default; the token is a second gate for shared machines.
  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (!token) return next();
    const provided = req.header("x-admin-token") ?? (req.query["token"] as string | undefined);
    if (provided === token) return next();
    res.status(401).json({ error: "unauthorized" });
  });

  app.get("/api/status", (_req, res) => {
    const cfg = getConfig();
    const bot = getBotStatus();
    res.json({
      bot: {
        ...bot,
        applicationId: bot.applicationId ?? applicationIdFromToken(),
        tokenPresent: Boolean(process.env.DISCORD_TOKEN?.trim()),
        apiKeyPresent: hasCredentials(),
      },
      docs: {
        ...docsIndex.status,
        repoUrl: redactUrl(cfg.docs.repoUrl),
        fileCount: docsIndex.fileCount,
        totalBytes: docsIndex.totalBytes,
        indexedAt: docsIndex.indexedAt,
        syncing: docsIndex.syncing,
      },
      model: cfg.model,
      modelLabel: getModel(cfg.model).label,
      /** False if the configured model isn't on this account's model list (e.g. retired). */
      modelListed: isListed(cfg.model),
      modelCatalog: catalogStatus(),
      effort: cfg.effort,
      costTodayUsd: costToday(),
      dailyCostLimitUsd: cfg.limits.dailyCostLimitUsd,
      authRequired: Boolean(token),
      startedAt,
      nodeVersion: process.version,
    });
  });

  app.get("/api/config", (_req, res) => {
    res.json({ config: getConfig(), defaults: defaultConfig });
  });

  app.put("/api/config", (req, res) => {
    const next = updateConfig(req.body);
    log.info("config updated via admin panel");
    res.json({ config: next });
  });

  app.post("/api/config/reset", (_req, res) => {
    const next = updateConfig(defaultConfig);
    log.warn("config reset to defaults");
    res.json({ config: next });
  });

  const modelsPayload = () => ({ models: listModels(), status: catalogStatus() });

  app.get("/api/models", (_req, res) => {
    res.json(modelsPayload());
  });

  app.post("/api/models/refresh", (_req, res) => {
    refreshCatalog()
      .then(() => res.json(modelsPayload()))
      .catch((err: unknown) =>
        res.status(502).json({ ...modelsPayload(), error: err instanceof Error ? err.message : String(err) }),
      );
  });

  app.post("/api/docs/sync", (req, res) => {
    const pull = req.body?.pull !== false;
    docsIndex
      .sync({ pull })
      .then(() =>
        res.json({
          ok: true,
          fileCount: docsIndex.fileCount,
          commit: docsIndex.status.commit,
        }),
      )
      .catch((err: unknown) =>
        res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      );
  });

  app.get("/api/docs/files", (req, res) => {
    const prefix = String(req.query["prefix"] ?? "");
    res.json({ files: docsIndex.list(prefix).slice(0, 2000) });
  });

  app.get("/api/docs/search", (req, res) => {
    const query = String(req.query["q"] ?? "");
    res.json({ hits: query ? docsIndex.search(query, { maxResults: 10 }) : [] });
  });

  app.get("/api/usage", (req, res) => {
    const days = Math.min(Math.max(Number(req.query["days"]) || 30, 1), 365);
    res.json(summarize(days));
  });

  app.get("/api/conversations", (_req, res) => {
    res.json({ conversations: listConversations() });
  });

  app.delete("/api/conversations", (_req, res) => {
    res.json({ cleared: clearAllConversations() });
  });

  app.delete("/api/conversations/:id", (req, res) => {
    res.json({ cleared: clearConversation(req.params["id"] ?? "") });
  });

  app.get("/api/logs", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query["limit"]) || 200, 1), 500);
    res.json({ logs: recentLogs(limit) });
  });

  app.use(express.static(publicDir()));

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    let listening = false;

    // The admin port doubles as a single-instance lock: two copies on one Discord
    // token answer every message twice and bill you twice. On Windows the listen
    // callback fires *before* EADDRINUSE arrives, so a late error still has to be
    // fatal — otherwise the duplicate silently carries on and logs into Discord.
    server.on("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "EADDRINUSE"
          ? `Port ${port} is already in use — another copy of this bot is already running. ` +
            "Two copies on the same token reply to every message twice. Stop the other one " +
            "(or set a different ADMIN_PORT) and start again."
          : `admin server failed: ${err.message}`;
      if (listening) {
        log.error(message);
        process.exit(1);
      }
      reject(new Error(message));
    });

    server.listen(port, "127.0.0.1", () => {
      listening = true;
      log.info(`admin panel at http://127.0.0.1:${port}${token ? " (token required)" : ""}`);
      resolve();
    });
  });
}
