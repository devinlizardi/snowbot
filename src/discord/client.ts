import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import type { Config } from '../config.js';
import { optionalSecret } from '../config.js';
import type { DB } from '../db.js';
import { log } from '../logger.js';

export type ChannelTarget = 'real' | 'test';

export type PostResult = {
  /** null when the post was suppressed by the budget or by dry-run. */
  messageId: string | null;
  suppressed: boolean;
  reason?: string;
};

export type PosterOptions = {
  /** Nothing is sent or edited; every call is logged instead. */
  dryRun: boolean;
  /** Which guild/channel pair to act on. */
  target: ChannelTarget;
  /** Job name, for the posts ledger. */
  job: string;
};

/**
 * The only thing in the codebase allowed to talk to Discord.
 *
 * Enforces PLAN.md §2: root posts are rationed, everything with a tail goes in
 * a thread, and the Aspen status is an edit rather than a new message. Every
 * send, edit and suppression is written to `posts` so the volume is auditable
 * after the fact rather than guessed at.
 */
export class Poster {
  private client: Client | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly db: DB,
    private readonly opts: PosterOptions,
  ) {}

  get channelId(): string | undefined {
    return this.cfg.channels[this.opts.target].channelId;
  }

  get guildId(): string | undefined {
    return this.cfg.channels[this.opts.target].guildId;
  }

  /**
   * Log in. Returns false when no token is configured — a dry run is still
   * useful without one, so this is a warning rather than a failure.
   */
  async connect(): Promise<boolean> {
    const token = optionalSecret('DISCORD_BOT_TOKEN');
    if (!token) {
      if (!this.opts.dryRun) {
        throw new Error('DISCORD_BOT_TOKEN is not set and this is not a dry run');
      }
      log.warn('no DISCORD_BOT_TOKEN — continuing offline, nothing will be sent');
      return false;
    }
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(token);
    await new Promise<void>((res) => {
      if (client.isReady()) return res();
      client.once('clientReady', () => res());
    });
    this.client = client;
    log.info('discord connected', { user: client.user?.tag, target: this.opts.target });
    return true;
  }

  async destroy(): Promise<void> {
    await this.client?.destroy();
    this.client = null;
  }

  private async channel(): Promise<TextChannel> {
    if (!this.client) throw new Error('not connected');
    const id = this.channelId;
    if (!id) throw new Error(`no channel id configured for target "${this.opts.target}"`);
    const ch = await this.client.channels.fetch(id);
    if (!ch || !ch.isTextBased() || ch.isDMBased()) {
      throw new Error(`channel ${id} is not a guild text channel`);
    }
    return ch as TextChannel;
  }

  /* ------------------------------------------------------------- budget */

  /** Root posts already made in the trailing 24h against this channel. */
  rootPostsToday(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM posts
         WHERE kind = 'root' AND channel_id = ? AND at > datetime('now', '-1 day')`,
      )
      .get(this.channelId ?? '') as { n: number };
    return row.n;
  }

  private record(kind: 'root' | 'edit' | 'thread' | 'suppressed', messageId: string | null, summary: string) {
    this.db
      .prepare(
        `INSERT INTO posts (job, channel_id, message_id, kind, dry_run, summary)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(this.opts.job, this.channelId ?? '', messageId, kind, this.opts.dryRun ? 1 : 0, summary.slice(0, 500));
  }

  /* -------------------------------------------------------------- posts */

  /**
   * A new message in the channel proper. Reserved for news — see PLAN.md §2.
   * Refused once the daily budget is spent, and the refusal is logged so the
   * budget can be tuned against real traffic instead of vibes.
   */
  async postRoot(content: string, opts: { urgent?: boolean } = {}): Promise<PostResult> {
    const used = this.rootPostsToday();
    const cap = this.cfg.discord.max_root_posts_per_day;
    if (!opts.urgent && used >= cap) {
      const reason = `root-post budget spent (${used}/${cap} in 24h)`;
      log.warn('root post suppressed', { job: this.opts.job, reason });
      this.record('suppressed', null, `${reason}: ${content.slice(0, 120)}`);
      return { messageId: null, suppressed: true, reason };
    }
    if (this.opts.dryRun || !this.client) {
      log.info('[dry-run] would post to root', { target: this.opts.target, chars: content.length });
      console.log(divider('ROOT POST', this.opts.target), '\n' + content + '\n');
      this.record('root', null, content.slice(0, 200));
      return { messageId: null, suppressed: false };
    }
    const msg = await (await this.channel()).send({ content, allowedMentions: { parse: ['users'] } });
    this.record('root', msg.id, content.slice(0, 200));
    return { messageId: msg.id, suppressed: false };
  }

  /** Edit an existing message in place. The anchor's whole reason for being. */
  async editMessage(messageId: string, content: string): Promise<PostResult> {
    if (this.opts.dryRun || !this.client) {
      log.info('[dry-run] would edit message', { messageId, chars: content.length });
      console.log(divider(`EDIT ${messageId}`, this.opts.target), '\n' + content + '\n');
      this.record('edit', messageId, content.slice(0, 200));
      return { messageId, suppressed: false };
    }
    const ch = await this.channel();
    const msg = await ch.messages.fetch(messageId);
    await msg.edit({ content, allowedMentions: { parse: [] } });
    this.record('edit', messageId, content.slice(0, 200));
    return { messageId, suppressed: false };
  }

  /** Fetch a message, or undefined if it was deleted. Callers degrade to a new post. */
  async fetchMessage(messageId: string): Promise<Message | undefined> {
    if (!this.client) return undefined;
    try {
      return await (await this.channel()).messages.fetch(messageId);
    } catch {
      return undefined;
    }
  }

  async pin(messageId: string): Promise<void> {
    if (this.opts.dryRun || !this.client) {
      log.info('[dry-run] would pin', { messageId });
      return;
    }
    const msg = await this.fetchMessage(messageId);
    if (msg && !msg.pinned) await msg.pin();
  }

  /** Create the thread hanging off a root message, or return the existing one. */
  async ensureThread(messageId: string, name: string): Promise<string | null> {
    if (this.opts.dryRun || !this.client) {
      log.info('[dry-run] would open thread', { messageId, name });
      return null;
    }
    const msg = await this.fetchMessage(messageId);
    if (!msg) return null;
    if (msg.hasThread && msg.thread) return msg.thread.id;
    const thread = await msg.startThread({ name: name.slice(0, 100), autoArchiveDuration: 10080 });
    return thread.id;
  }

  /** Thread replies are unbudgeted: they don't ping the channel. */
  async postThread(threadId: string | null, content: string): Promise<PostResult> {
    if (this.opts.dryRun || !this.client || !threadId) {
      log.info('[dry-run] would post in thread', { threadId, chars: content.length });
      console.log(divider(`THREAD ${threadId ?? '(new)'}`, this.opts.target), '\n' + content + '\n');
      this.record('thread', threadId, content.slice(0, 200));
      return { messageId: null, suppressed: false };
    }
    if (!this.client) throw new Error('not connected');
    const ch = await this.client.channels.fetch(threadId);
    if (!ch || !ch.isThread()) throw new Error(`${threadId} is not a thread`);
    const msg = await (ch as ThreadChannel).send({ content, allowedMentions: { parse: ['users'] } });
    this.record('thread', msg.id, content.slice(0, 200));
    return { messageId: msg.id, suppressed: false };
  }
}

function divider(label: string, target: ChannelTarget): string {
  return `\n──── ${label} · ${target} ${'─'.repeat(Math.max(0, 40 - label.length))}`;
}
