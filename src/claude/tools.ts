import type Anthropic from "@anthropic-ai/sdk";
import { docsIndex } from "../docs/index.js";
import type { ServerSnapshot } from "../discord/server-context.js";

/** Per-request state the tools may read. Null server means a DM. */
export interface ToolContext {
  server: ServerSnapshot | null;
}

/**
 * Tool definitions are static so they stay byte-identical across requests —
 * tools render before `system`, so any change here invalidates the prompt cache.
 */
export const docsTools: Anthropic.Tool[] = [
  {
    name: "search_docs",
    description:
      "Full-text keyword search across the project documentation. Returns the best-matching files with " +
      "matching line numbers and snippets. Use this first for any project-specific question; run several " +
      "searches with different wording if the first one comes back thin.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keywords to search for. Prefer distinctive nouns and identifiers over full sentences.",
        },
        path_prefix: {
          type: "string",
          description: "Optional: restrict the search to a directory, e.g. 'guides' or 'api/reference'.",
        },
        max_results: {
          type: "integer",
          description: "Maximum number of files to return (1-20, default 6).",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_doc",
    description:
      "Read the contents of one documentation file, with line numbers. Use after search_docs to get the " +
      "full context around a hit. Reads at most 400 lines at a time — pass start_line/end_line to page " +
      "through longer files.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path exactly as it appears in the index or in search results.",
        },
        start_line: { type: "integer", description: "First line to read (1-based, default 1)." },
        end_line: { type: "integer", description: "Last line to read (default start_line + 399)." },
      },
      required: ["path"],
    },
  },
  {
    name: "list_channels",
    description:
      "List the channels in the Discord server this question came from, with their category and " +
      "topic. Use for questions like 'where should I post this', 'which channel covers X', or " +
      "'what is #foo for'. Only channels the person asking can already see are returned.",
    input_schema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: "Optional: only channels in this category, e.g. 'Support'.",
        },
        name_contains: {
          type: "string",
          description: "Optional: only channels whose name contains this text.",
        },
      },
      required: [],
    },
  },
  {
    name: "list_roles",
    description:
      "List the roles in this Discord server, including which notable permissions each one grants. " +
      "Use for questions like 'what does the moderator role do', 'who can I ask about X', or " +
      "'which role do I need for Y'.",
    input_schema: {
      type: "object",
      properties: {
        name_contains: {
          type: "string",
          description: "Optional: only roles whose name contains this text.",
        },
      },
      required: [],
    },
  },
  {
    name: "server_info",
    description:
      "Basic facts about the Discord server this question came from: its name, member count, how " +
      "many channels and roles exist, and the roles held by the person asking. Cheap — call it " +
      "before list_channels/list_roles if you only need an overview.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "list_docs",
    description:
      "List indexed documentation files, optionally under a directory prefix. Use to discover what exists " +
      "when search comes back empty or the index in your system prompt was truncated.",
    input_schema: {
      type: "object",
      properties: {
        path_prefix: {
          type: "string",
          description: "Optional directory prefix, e.g. 'api'. Omit to list everything.",
        },
      },
      required: [],
    },
  },
];

export interface ToolOutcome {
  content: string;
  isError: boolean;
  /** Short human-readable description, shown as progress in Discord. */
  summary: string;
}

export async function executeTool(
  name: string,
  rawInput: unknown,
  context: ToolContext = { server: null },
): Promise<ToolOutcome> {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "search_docs":
        return searchDocs(input);
      case "read_doc":
        return readDoc(input);
      case "list_docs":
        return listDocs(input);
      case "list_channels":
        return listChannels(input, context);
      case "list_roles":
        return listRoles(input, context);
      case "server_info":
        return serverInfo(context);
      default:
        return { content: `Unknown tool: ${name}`, isError: true, summary: `unknown tool ${name}` };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: `Tool failed: ${message}`, isError: true, summary: `${name} failed` };
  }
}

function searchDocs(input: Record<string, unknown>): ToolOutcome {
  const query = String(input["query"] ?? "").trim();
  if (!query) {
    return { content: "The 'query' parameter is required.", isError: true, summary: "search (no query)" };
  }
  if (!docsIndex.ready) {
    return {
      content: "No documentation is indexed. Tell the user the docs are unavailable rather than guessing.",
      isError: true,
      summary: "search (no docs indexed)",
    };
  }

  const hits = docsIndex.search(query, {
    maxResults: numberOr(input["max_results"], 6),
    pathPrefix: String(input["path_prefix"] ?? ""),
  });

  if (hits.length === 0) {
    return {
      content: `No matches for "${query}". Try different keywords, or use list_docs to browse.`,
      isError: false,
      summary: `searched "${truncate(query, 40)}" — no matches`,
    };
  }

  const body = hits
    .map((hit) => {
      const lines = hit.matches.map((m) => `  L${m.line}: ${m.text}`).join("\n");
      return `## ${hit.path}\n${hit.title}\n${lines || "  (matched on filename/title)"}`;
    })
    .join("\n\n");

  return {
    content: `${hits.length} file(s) matched "${query}":\n\n${body}\n\nUse read_doc to see full context.`,
    isError: false,
    summary: `searched "${truncate(query, 40)}" — ${hits.length} file(s)`,
  };
}

function readDoc(input: Record<string, unknown>): ToolOutcome {
  const relPath = String(input["path"] ?? "").trim();
  if (!relPath) {
    return { content: "The 'path' parameter is required.", isError: true, summary: "read (no path)" };
  }
  const start = input["start_line"] === undefined ? undefined : numberOr(input["start_line"], 1);
  const end = input["end_line"] === undefined ? undefined : numberOr(input["end_line"], 400);
  const result = docsIndex.read(relPath, start, end);

  if (!result) {
    // Match on the bare file stem so "guides/authz.md" still suggests "guides/auth.md".
    const stem = (relPath.toLowerCase().split("/").pop() ?? "").replace(/\.[^.]+$/, "");
    const near = stem.length < 3
      ? []
      : docsIndex
          .list()
          .filter((f) => {
            const candidate = (f.path.toLowerCase().split("/").pop() ?? "").replace(/\.[^.]+$/, "");
            return candidate.includes(stem) || stem.includes(candidate);
          })
          .slice(0, 5)
          .map((f) => f.path);
    return {
      content:
        `No indexed file at "${relPath}".` +
        (near.length ? ` Did you mean one of: ${near.join(", ")}?` : " Use list_docs to see what exists."),
      isError: true,
      summary: `read ${truncate(relPath, 50)} — not found`,
    };
  }

  if (result.from > result.totalLines) {
    return {
      content: `${result.path} has only ${result.totalLines} lines; start_line ${result.from} is past the end.`,
      isError: true,
      summary: `read ${truncate(result.path, 50)} — past end`,
    };
  }

  const header = `# ${result.path} (lines ${result.from}-${result.to} of ${result.totalLines})`;
  return {
    content: `${header}\n\n${result.content}`,
    isError: false,
    summary: `read ${truncate(result.path, 50)}`,
  };
}

function listDocs(input: Record<string, unknown>): ToolOutcome {
  const prefix = String(input["path_prefix"] ?? "").trim();
  const files = docsIndex.list(prefix);
  if (files.length === 0) {
    return {
      content: prefix ? `Nothing indexed under "${prefix}".` : "No documentation is indexed.",
      isError: false,
      summary: `listed ${prefix || "/"} — empty`,
    };
  }
  const shown = files.slice(0, 300);
  const body = shown.map((f) => `${f.path} (${f.lines} lines) — ${f.title}`).join("\n");
  const more = files.length > shown.length ? `\n… and ${files.length - shown.length} more` : "";
  return {
    content: `${files.length} file(s)${prefix ? ` under "${prefix}"` : ""}:\n\n${body}${more}`,
    isError: false,
    summary: `listed ${prefix || "/"} — ${files.length} file(s)`,
  };
}

const NO_SERVER =
  "This question came from a direct message, so there is no server context available. " +
  "Ask the user to run this in the server they're asking about.";

function listChannels(input: Record<string, unknown>, context: ToolContext): ToolOutcome {
  const server = context.server;
  if (!server) return { content: NO_SERVER, isError: true, summary: "channels (not in a server)" };

  const category = String(input["category"] ?? "").trim().toLowerCase();
  const nameContains = String(input["name_contains"] ?? "").trim().toLowerCase();

  const matches = server.channels.filter((channel) => {
    if (category && (channel.category ?? "").toLowerCase() !== category) return false;
    if (nameContains && !channel.name.toLowerCase().includes(nameContains)) return false;
    return true;
  });

  if (matches.length === 0) {
    return {
      content: `No channels matched${category ? ` in category "${category}"` : ""}${
        nameContains ? ` containing "${nameContains}"` : ""
      }. Call list_channels with no arguments to see everything visible to this user.`,
      isError: false,
      summary: "listed channels — no matches",
    };
  }

  const byCategory = new Map<string, typeof matches>();
  for (const channel of matches) {
    const key = channel.category ?? "(no category)";
    const bucket = byCategory.get(key) ?? [];
    bucket.push(channel);
    byCategory.set(key, bucket);
  }

  const body = [...byCategory.entries()]
    .map(([cat, list]) => {
      const lines = list.map((channel) => {
        const bits = [`#${channel.name}`, `(${channel.type})`];
        if (!channel.botCanRead) bits.push("[I cannot read this one]");
        const head = `- ${bits.join(" ")}`;
        return channel.topic ? `${head}\n    topic: ${channel.topic}` : head;
      });
      return `## ${cat}\n${lines.join("\n")}`;
    })
    .join("\n\n");

  const note = server.omittedChannels
    ? `\n\n(${server.omittedChannels} further channels were omitted — this server is large.)`
    : "";

  return {
    content:
      `${matches.length} channel(s) in "${server.name}" visible to ${server.askerName}:\n\n${body}${note}\n\n` +
      "Channels this user cannot see are not listed — do not speculate about hidden channels.",
    isError: false,
    summary: `listed ${matches.length} channel(s)`,
  };
}

function listRoles(input: Record<string, unknown>, context: ToolContext): ToolOutcome {
  const server = context.server;
  if (!server) return { content: NO_SERVER, isError: true, summary: "roles (not in a server)" };

  const nameContains = String(input["name_contains"] ?? "").trim().toLowerCase();
  const matches = server.roles.filter(
    (role) => !nameContains || role.name.toLowerCase().includes(nameContains),
  );

  if (matches.length === 0) {
    return {
      content: `No roles matched "${nameContains}". Call list_roles with no arguments to see them all.`,
      isError: false,
      summary: "listed roles — no matches",
    };
  }

  const body = matches
    .map((role) => {
      const tags: string[] = [];
      if (role.managed) tags.push("managed by an integration");
      if (role.hoisted) tags.push("shown separately in the member list");
      if (role.mentionable) tags.push("mentionable");
      const perms = role.keyPermissions.length
        ? `permissions: ${role.keyPermissions.join(", ")}`
        : "no elevated permissions";
      return `- @${role.name} — ${perms}${tags.length ? ` (${tags.join("; ")})` : ""}`;
    })
    .join("\n");

  return {
    content:
      `${matches.length} role(s) in "${server.name}", highest first:\n\n${body}\n\n` +
      "Only notable permissions are listed. Member counts per role are not available.",
    isError: false,
    summary: `listed ${matches.length} role(s)`,
  };
}

function serverInfo(context: ToolContext): ToolOutcome {
  const server = context.server;
  if (!server) return { content: NO_SERVER, isError: true, summary: "server info (not in a server)" };

  const readable = server.channels.filter((c) => c.botCanRead).length;
  const lines = [
    `Server: ${server.name}`,
    `Members: ${server.memberCount}`,
    `Channels visible to this user: ${server.channels.length} (I can read ${readable} of them)`,
    `Roles: ${server.roles.length}`,
    `Asking user: ${server.askerName}`,
    `Their roles: ${server.askerRoles.length ? server.askerRoles.join(", ") : "none beyond @everyone"}`,
  ];
  return {
    content: lines.join("\n"),
    isError: false,
    summary: `server info for ${server.name}`,
  };
}

function numberOr(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
