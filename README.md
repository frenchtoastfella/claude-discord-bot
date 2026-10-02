# Claude Discord Bot

A Discord bot that answers questions about your project by reading its documentation. It runs on
your machine, keeps a local clone of a docs git repo, and lets Claude search and read that repo
through tools rather than stuffing everything into a prompt. A localhost admin panel handles
configuration, model selection, and usage/cost tracking.

## How it works

```
Discord message (@mention / reply / DM)
        │
        ▼
  agentic loop ──▶ search_docs ────┐
  (Claude API)  ◀── read_doc  ─────┤  local clone of your docs repo
                ◀── list_docs ─────┘  (git pull on an interval)
                │
                ├─▶ server_info ───┐
                ├─▶ list_channels ─┤  this Discord server's own
                └─▶ list_roles ────┘  channels and roles
        │
        ▼
  streamed answer, edited into the Discord message as it arrives
```

Claude decides which files to look at, the same way a person would: search, read the promising
hits, then answer. There's no vector database, no embedding provider, and no chunking to tune —
when the docs change, the next `git pull` is the whole update.

It can also answer questions about the Discord server itself — "where do I report a bug?", "what
does the Moderator role do?" — via `server_info`, `list_channels`, and `list_roles`. These read
discord.js's cache, so they cost no API calls and need no privileged intents beyond the one you
already enabled. **`list_channels` only ever returns channels the person asking can already see**,
so the bot can't be used to fish for the names or topics of private channels.

A compact index of every file (path + title) sits in the system prompt behind a cache breakpoint,
so Claude knows what exists before searching, and that prefix is served from cache on every
subsequent message until the docs change.

## Setup

**1. Install dependencies**

```bash
npm install
```

**2. Create a Discord application**

- Go to <https://discord.com/developers/applications> → **New Application**.
- **Bot** tab → **Reset Token** → copy it.
- Same tab, scroll to **Privileged Gateway Intents** → enable **Message Content Intent**. The bot
  cannot read message text without this.
- Inviting it to a server is handled by the panel's **Setup** tab once it's running (step 4) — it
  builds the OAuth URL from your own application id with exactly the permissions the bot uses.

**3. Configure credentials**

```bash
copy .env.example .env
```

Fill in `DISCORD_TOKEN` and `ANTHROPIC_API_KEY`. Get an API key at
<https://console.anthropic.com/settings/keys>.

**4. Run it**

```bash
npm run dev
```

Then open <http://127.0.0.1:8787>, set your documentation repository URL under **Configuration**,
and hit **Pull & reindex** on the Overview tab.

For a long-running process, build first:

```bash
npm run build
npm start
```

## Admin panel

At `http://127.0.0.1:8787` (bound to loopback only — it is not reachable from your network).

| Tab | What's there |
| --- | --- |
| **Overview** | Connection status, indexed file count, current docs revision, manual pull/reindex |
| **Setup** | Live readiness checklist, a generated invite link for your server, and troubleshooting |
| **Configuration** | Model and effort, system prompt, docs repo, trigger rules, memory, limits |
| **Usage & Cost** | Daily spend chart, totals, cache hit rate, breakdown by model/user/channel, recent requests |
| **Docs** | Run the bot's own search against the index, browse indexed files |
| **Conversations** | Per-channel memory, clear individually or all |
| **Logs** | Live tail of the process log |

Everything except the ports and tokens in `.env` applies to the next message with no restart.

Set `ADMIN_TOKEN` in `.env` if other people have accounts on this machine; the panel will prompt
for it and remember it in `localStorage`.

## Configuration notes

**Model.** The dropdown is populated from your Anthropic account via the Models API — refreshed at
startup, every 12 hours, and on demand with **Refresh model list** — so newly released models appear
without a code change. The list is cached in `data/models-cache.json` so the panel still works if
the API is unreachable. Each model's reported capabilities decide what the bot sends: effort levels a
model doesn't accept are greyed out and stepped down automatically, and adaptive thinking is only
requested where supported.

The Models API doesn't report prices, so those come from the table in `src/claude/pricing.ts`. A
model missing from it gets a family-based estimate, marked **(est.)** in the dropdown and erring high
so the daily cost limit trips early rather than late. Add a row there when a new model ships.

**Effort.** Defaults to `medium`, which suits most documentation Q&A. Raise to `high` for questions
that need synthesis across many files; drop to `low` if you mainly want fast lookups.

**Docs source.** `includeGlobs` defaults to markdown and text. Add `**/*.ts` (or whatever your
project uses) if you want the bot to answer "how does X actually work" from source as well as prose.
For a private repo, either embed a token in the HTTPS URL
(`https://x-access-token:<PAT>@github.com/org/repo.git`) or rely on your machine's existing git
credential helper. The URL is redacted everywhere it's displayed or logged.

**When it responds.** @mentions, replies to its own messages, and DMs by default. Add entries to
`alwaysRespondChannelIds` to make it answer everything in a channel — either a channel name
(`bot-discussion` or `#bot-discussion`) or a numeric channel ID; threads inherit their parent
channel. `allowedGuildIds` restricts it to specific servers; leave empty for all.

**Run one copy at a time.** The admin port doubles as a single-instance lock — a second copy exits
rather than starting, because two instances sharing a token answer every message twice and bill you
twice.

**Cost control.** `maxRequestsPerUserPerHour` (default 30) and `dailyCostLimitUsd` (default 0 =
unlimited) both refuse work before any tokens are spent. The Usage tab shows what you're actually
spending — check the cache hit rate there; a healthy setup serves most input tokens from cache.

## Layout

```
src/
  index.ts              startup, scheduling, graceful shutdown
  config.ts             config schema, defaults, validation, live reload
  claude/
    agent.ts            the streaming tool-use loop
    tools.ts            search_docs / read_doc / list_docs
    models.ts           model catalog and cost maths
  docs/
    git.ts              clone / fetch / reset the docs repo
    index.ts            file index, keyword search, prompt index rendering
  discord/
    bot.ts              gateway client, trigger rules, guardrails
    responder.ts        streams an answer into Discord messages
  store/
    usage.ts            append-only usage log and aggregation
    conversations.ts    per-channel memory
  admin/
    server.ts           localhost API
    public/index.html   dashboard
```

Runtime state lives in `data/` (config, docs clone, usage log, conversation memory) and is
gitignored. Deleting it resets the bot to defaults.
