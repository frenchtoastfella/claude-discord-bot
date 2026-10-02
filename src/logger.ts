export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
}

const RING_SIZE = 500;
const ring: LogEntry[] = [];

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function emit(level: LogLevel, scope: string, args: unknown[]): void {
  const message = args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.message}\n${a.stack ?? ""}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

  const entry: LogEntry = { ts: Date.now(), level, scope, message };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const stamp = new Date(entry.ts).toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (...args: unknown[]) => emit("debug", scope, args),
    info: (...args: unknown[]) => emit("info", scope, args),
    warn: (...args: unknown[]) => emit("warn", scope, args),
    error: (...args: unknown[]) => emit("error", scope, args),
  };
}

/** Recent log lines, newest last. Surfaced in the admin panel. */
export function recentLogs(limit = 200): LogEntry[] {
  return ring.slice(-limit);
}
