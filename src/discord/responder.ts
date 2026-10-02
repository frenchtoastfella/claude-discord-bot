import type { Message, TextBasedChannel } from "discord.js";
import { createLogger } from "../logger.js";

const log = createLogger("responder");

const CHUNK_LIMIT = 1900;
const EDIT_INTERVAL_MS = 1250;

/**
 * Split text into Discord-sized chunks, preferring paragraph then line breaks,
 * and keeping code fences balanced across the split.
 */
export function splitForDiscord(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(" ", limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length > 0) chunks.push(rest);

  // Re-balance code fences so a chunk never ends mid-block.
  let openFence: string | null = null;
  return chunks.map((chunk) => {
    let out = chunk;
    if (openFence) out = `${openFence}\n${out}`;
    const fences = out.match(/^```[^\n]*$/gm) ?? [];
    if (fences.length % 2 === 1) {
      openFence = fences[fences.length - 1]!.trim();
      out = `${out}\n\`\`\``;
    } else {
      openFence = null;
    }
    return out;
  });
}

/**
 * Renders a growing answer into one or more Discord messages, editing in place
 * as tokens arrive instead of waiting for the full response.
 */
export class StreamingReply {
  private messages: Message[] = [];
  private rendered: string[] = [];
  private lastEditAt = 0;
  private pending: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly channel: TextBasedChannel,
    private readonly replyTo: Message | null,
  ) {}

  /** Post the placeholder message so the user sees immediate acknowledgement. */
  async start(initial = "_thinking…_"): Promise<void> {
    const first = await this.send(initial);
    if (first) this.messages.push(first);
    this.rendered = [initial];
  }

  /** Throttled progressive update. Safe to call on every token. */
  update(text: string): void {
    if (this.closed) return;
    this.pending = text;
    const wait = Math.max(0, EDIT_INTERVAL_MS - (Date.now() - this.lastEditAt));
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const next = this.pending;
      this.pending = null;
      if (next !== null) this.enqueue(next);
    }, wait);
    this.timer.unref?.();
  }

  /** Final render. Cancels any pending throttled update. */
  async finish(text: string): Promise<void> {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.enqueue(text || "_(no response)_", true);
    await this.inFlight;
  }

  private enqueue(text: string, final = false): void {
    this.inFlight = this.inFlight.then(() => this.render(text, final)).catch((err) => {
      log.warn("render failed:", err);
    });
  }

  private async render(text: string, final: boolean): Promise<void> {
    this.lastEditAt = Date.now();
    const chunks = splitForDiscord(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      if (this.rendered[i] === chunk) continue;

      const existing = this.messages[i];
      if (existing) {
        await existing.edit(chunk).catch((err) => log.warn("edit failed:", err));
      } else {
        const sent = await this.send(chunk);
        if (!sent) return;
        this.messages.push(sent);
      }
      this.rendered[i] = chunk;
    }

    // The answer shrank (e.g. a tool preamble was discarded). Mid-stream, blank the
    // extra messages since more text may refill them; on the final render, delete
    // them so no stray "…" posts are left in the channel.
    if (final) {
      for (const extra of this.messages.splice(chunks.length)) {
        await extra.delete().catch((err) => log.warn("delete failed:", err));
      }
      this.rendered.length = chunks.length;
      return;
    }
    for (let i = chunks.length; i < this.messages.length; i++) {
      if (this.rendered[i] === "") continue;
      await this.messages[i]!.edit("_…_").catch(() => {});
      this.rendered[i] = "";
    }
  }

  private async send(content: string): Promise<Message | null> {
    try {
      if (this.messages.length === 0 && this.replyTo) {
        return await this.replyTo.reply({
          content,
          allowedMentions: { repliedUser: false, parse: [] },
        });
      }
      if (!("send" in this.channel)) return null;
      return await this.channel.send({ content, allowedMentions: { parse: [] } });
    } catch (err) {
      log.error("failed to send message:", err);
      return null;
    }
  }
}
