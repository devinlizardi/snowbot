import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { kvGet, kvSet } from '../db.js';
import type { Logger } from '../logger.js';
import type { Poster } from './client.js';

/**
 * The self-editing Aspen status message (PLAN.md §2 rule 1).
 *
 * One message, pinned, rewritten in place by every weekly/daily update. Its id
 * lives in `kv` so restarts find it again, and if someone deletes it the next
 * update simply posts a fresh one instead of failing. The only thing that ever
 * creates a second anchor is the first one going missing.
 */

export type AnchorContext = {
  poster: Poster;
  db: DB;
  cfg: Config;
  log: Logger;
};

export type AnchorResult = {
  /** null when nothing was sent: dry run, offline, or the budget refused a new root. */
  messageId: string | null;
  /** true when a new root message was posted (or would have been, in a dry run). */
  created: boolean;
};

/** Discord's hard cap on message content. */
export const DISCORD_MAX_CHARS = 2000;

/**
 * Dry runs without a token never get a real id back, so we remember a marker
 * instead. It keeps repeated dry runs editing rather than re-creating, and a
 * later live run can tell it apart from a real snowflake and post properly.
 */
const DRY_RUN_PREFIX = 'dry-run:';
const isPlaceholder = (id: string) => id.startsWith(DRY_RUN_PREFIX);
// Two anchors created in the same millisecond must still get distinct ids.
const placeholderId = () =>
  `${DRY_RUN_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** kv key for the anchor in the channel this poster targets. */
export function anchorKeyFor(poster: Poster): string {
  return `anchor:${poster.channelId ?? 'unconfigured'}`;
}

export function readAnchorId(db: DB, key: string): string | undefined {
  return kvGet(db, key);
}

export async function upsertAnchor(
  ctx: AnchorContext,
  content: string,
  opts: { key?: string } = {},
): Promise<AnchorResult> {
  const { poster, db, cfg, log } = ctx;
  const key = opts.key ?? anchorKeyFor(poster);
  const existing = readAnchorId(db, key);

  if (existing) {
    // Offline we cannot verify anything, so trust kv — otherwise every dry run
    // would "create" a new anchor and the one-message invariant is untestable.
    const trusted =
      !poster.connected || (!isPlaceholder(existing) && (await poster.fetchMessage(existing)));
    if (trusted) {
      await poster.editMessage(existing, content);
      return { messageId: existing, created: false };
    }
    log.warn('anchor message missing — posting a new one', { key, previous: existing });
  }

  // News-free by design: if the day's budget is gone, the old anchor (if any)
  // just goes stale for a while rather than the bot bending its own rule.
  const posted = await poster.postRoot(content);
  if (posted.suppressed) {
    log.warn('anchor not created: root post suppressed', { key, reason: posted.reason });
    return { messageId: null, created: false };
  }

  const id = posted.messageId ?? placeholderId();
  kvSet(db, key, id);
  if (cfg.discord.anchor.pin) await poster.pin(id);
  log.info('anchor created', { key, messageId: id, pinned: cfg.discord.anchor.pin });
  return { messageId: posted.messageId, created: true };
}

/* ------------------------------------------------------------- rendering */

export type Confidence = 'high' | 'medium' | 'low';

export type AnchorStatus = {
  /** Days until window_start; 0 on the day, negative once the trip is underway. */
  daysOut: number;
  baseDepthIn?: number;
  nextStorm?: { day: string; cm: number; confidence: Confidence };
  updatedAt: Date;
  /** IANA zone for the "updated" stamp; defaults to UTC. */
  timezone?: string;
  headline?: string;
  sections?: { title: string; body: string }[];
};

const TRUNCATED = '\n… _(truncated)_';

function countdown(daysOut: number): string {
  if (daysOut > 1) return `${daysOut} days out`;
  if (daysOut === 1) return 'tomorrow';
  if (daysOut === 0) return 'today';
  return `day ${1 - daysOut} of the trip`;
}

function stamp(at: Date, timezone: string): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
  return fmt.format(at);
}

/**
 * Pure formatter for the anchor body. Header first, then headline, then the
 * sections in order, then an "updated" stamp — trimmed to Discord's 2000-char
 * limit by cutting sections from the bottom, never the header or the stamp.
 */
export function renderAnchor(status: AnchorStatus): string {
  const head = [`❄️ **ASPEN** · ${countdown(status.daysOut)}`];
  if (status.baseDepthIn !== undefined) head.push(`${Math.round(status.baseDepthIn)}" base`);
  if (status.nextStorm) {
    const s = status.nextStorm;
    head.push(`next storm ${s.day} ~${Math.round(s.cm)}cm (${s.confidence} confidence)`);
  }
  const header = head.join(' · ');
  const footer = `_Updated ${stamp(status.updatedAt, status.timezone ?? 'UTC')}_`;

  let out = header;
  if (status.headline) out += `\n${status.headline.trim()}`;

  // Everything below must leave room for the footer, which always ships.
  const room = () => DISCORD_MAX_CHARS - out.length - footer.length - 2;

  for (const section of status.sections ?? []) {
    const block = `\n\n**${section.title.trim()}**\n${section.body.trim()}`;
    if (block.length <= room()) {
      out += block;
      continue;
    }
    const keep = room() - TRUNCATED.length;
    // A title with nothing under it is worse than no title: cut the whole
    // section unless a meaningful slice of the body survives.
    if (keep > `\n\n**${section.title.trim()}**\n`.length + 20) {
      out += block.slice(0, keep).trimEnd();
    }
    if (room() >= TRUNCATED.length) out += TRUNCATED;
    break;
  }

  out += `\n\n${footer}`;
  return out.length <= DISCORD_MAX_CHARS ? out : out.slice(0, DISCORD_MAX_CHARS);
}
