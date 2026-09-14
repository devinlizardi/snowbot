import {
  ApplicationCommandOptionType,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Client,
} from 'discord.js';
import type { Config } from '../config.js';
import { kvGet, kvSet, type DB } from '../db.js';
import { log } from '../logger.js';

/*
 * Slash commands, split in two: `handle()` is a pure function of (command,
 * options, db, cfg, clock) and is what the tests exercise; the discord.js
 * plumbing at the bottom just marshals an interaction into that call. Anything
 * that needs a Poster or a job (a forced build, the Aspen status) is returned as
 * an `action` for the integrator rather than performed here, so this file never
 * imports a job and never posts.
 */

/* ---------------------------------------------------------------- types */

export type CommandContext = {
  db: DB;
  cfg: Config;
  now: Date;
  user: { id: string; name: string };
};

export type CommandAction =
  { kind: 'build'; destination?: string; month?: string } | { kind: 'trip' };

export type CommandResult = {
  reply: string;
  ephemeral?: boolean;
  action?: CommandAction;
};

export type CommandOpts = Record<string, string | number | undefined>;

/* ---------------------------------------------------------- definitions */

const IATA = /^[A-Z]{3}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_MONTH = /^\d{4}-\d{2}$/;
const QUIET_MAX_DAYS = 30;

export const COMMANDS = [
  new SlashCommandBuilder()
    .setName('join')
    .setDescription('Join the roster (seeds your airports from config)'),

  new SlashCommandBuilder()
    .setName('airports')
    .setDescription('Manage the airports you fly out of')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Add an airport')
        .addStringOption((o) =>
          o.setName('iata').setDescription('3-letter IATA code, e.g. JFK').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove an airport')
        .addStringOption((o) =>
          o.setName('iata').setDescription('3-letter IATA code').setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription('Show your airports')),

  new SlashCommandBuilder()
    .setName('flight')
    .setDescription('Your flights for the Aspen trip')
    .addSubcommand((s) =>
      s
        .setName('add')
        .setDescription('Register a flight so the bot can watch it')
        .addStringOption((o) =>
          o.setName('airline').setDescription('IATA airline code, e.g. UA').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('number').setDescription('Flight number, e.g. 1234').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('date').setDescription('Departure date, YYYY-MM-DD').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('origin').setDescription('Origin IATA, e.g. JFK').setRequired(true),
        )
        .addStringOption((o) =>
          o.setName('dest').setDescription('Destination IATA, e.g. ASE').setRequired(true),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('remove')
        .setDescription('Remove one of your flights')
        .addIntegerOption((o) =>
          o.setName('id').setDescription('Flight id from /flight list').setRequired(true),
        ),
    )
    .addSubcommand((s) => s.setName('list').setDescription("Everyone's upcoming flights")),

  new SlashCommandBuilder().setName('trip').setDescription('Aspen status right now'),

  new SlashCommandBuilder()
    .setName('build')
    .setDescription('Force an expedition build')
    .addStringOption((o) =>
      o.setName('destination').setDescription('Board id, e.g. niseko').setRequired(false),
    )
    .addStringOption((o) =>
      o.setName('month').setDescription('Target month, YYYY-MM').setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('watch')
    .setDescription('Start daily fare tracking for an expedition')
    .addStringOption((o) =>
      o.setName('id').setDescription('Expedition id from the dossier').setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('unwatch')
    .setDescription('Stop tracking an expedition')
    .addStringOption((o) => o.setName('id').setDescription('Expedition id').setRequired(true)),

  new SlashCommandBuilder()
    .setName('quiet')
    .setDescription('Mute non-urgent posts for a while')
    .addIntegerOption((o) =>
      o
        .setName('days')
        .setDescription(`1–${QUIET_MAX_DAYS}`)
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(QUIET_MAX_DAYS),
    ),
];

/* --------------------------------------------------------------- helpers */

type MemberRow = { id: number; discord_id: string | null; name: string; airports_json: string };
type FlightRow = {
  id: number;
  member_id: number;
  airline: string;
  number: string;
  date: string;
  origin: string;
  dest: string;
  last_status: string | null;
};

const ok = (reply: string, extra: Partial<CommandResult> = {}): CommandResult => ({
  reply,
  ...extra,
});
const oops = (reply: string): CommandResult => ({ reply, ephemeral: true });

const str = (opts: CommandOpts, key: string): string | undefined => {
  const v = opts[key];
  return v === undefined ? undefined : String(v).trim();
};

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

function memberFor(db: DB, discordId: string): MemberRow | undefined {
  return db.prepare('SELECT * FROM members WHERE discord_id = ?').get(discordId) as
    MemberRow | undefined;
}

function airportsOf(m: MemberRow): string[] {
  try {
    const parsed: unknown = JSON.parse(m.airports_json);
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

function setAirports(db: DB, m: MemberRow, airports: string[]): void {
  db.prepare('UPDATE members SET airports_json = ? WHERE id = ?').run(
    JSON.stringify(airports),
    m.id,
  );
}

function parseIata(raw: string | undefined, label: string): { code: string } | { error: string } {
  const code = (raw ?? '').toUpperCase();
  if (!IATA.test(code))
    return { error: `${label} should be a 3-letter IATA code like JFK, not "${raw ?? ''}".` };
  return { code };
}

/** True when the given YYYY-MM-DD names a real calendar day (rejects 2027-02-30). */
function isRealDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Jobs call this before any non-urgent root post. `/quiet` only ever writes
 * one key, so a stale or malformed value fails open — silence should never be
 * the accidental default.
 */
export function isQuiet(db: DB, now: Date): boolean {
  const until = kvGet(db, 'quiet_until');
  if (!until) return false;
  const t = Date.parse(until);
  return !Number.isNaN(t) && now.getTime() < t;
}

/* -------------------------------------------------------------- handlers */

function join(ctx: CommandContext): CommandResult {
  const { db, cfg, user } = ctx;
  const existing = memberFor(db, user.id);
  if (existing) {
    // Re-joining is a no-op: never reset airports the member curated with /airports.
    return ok(
      `You're already on the roster as **${existing.name}** (${airportsOf(existing).join(', ') || 'no airports'}).`,
      {
        ephemeral: true,
      },
    );
  }

  const seed = cfg.members.find((m) => m.name.toLowerCase() === user.name.toLowerCase());
  const name = seed?.name ?? user.name;
  const airports = seed?.airports ?? [];

  // A row may already exist under this name with no discord_id (seeded by a job
  // or a previous bot identity). Claim it rather than fail the UNIQUE(name).
  const orphan = db
    .prepare('SELECT * FROM members WHERE lower(name) = lower(?) AND discord_id IS NULL')
    .get(name) as MemberRow | undefined;
  if (orphan) {
    db.prepare('UPDATE members SET discord_id = ? WHERE id = ?').run(user.id, orphan.id);
    return ok(
      `Welcome back, **${orphan.name}** — airports: ${airportsOf(orphan).join(', ') || 'none yet'}.`,
    );
  }

  const taken = db.prepare('SELECT * FROM members WHERE lower(name) = lower(?)').get(name) as
    MemberRow | undefined;
  if (taken) {
    return oops(
      `Someone else already joined as **${taken.name}**. Ask them to check, or change your Discord display name.`,
    );
  }

  db.prepare('INSERT INTO members (discord_id, name, airports_json) VALUES (?, ?, ?)').run(
    user.id,
    name,
    JSON.stringify(airports),
  );
  const seeded = airports.length
    ? `airports seeded: ${airports.join(', ')}`
    : 'no airports on file — add some with `/airports add`';
  return ok(`Welcome, **${name}** — ${seeded}.`);
}

function airports(sub: string | null, opts: CommandOpts, ctx: CommandContext): CommandResult {
  const m = memberFor(ctx.db, ctx.user.id);
  if (!m) return oops('You are not on the roster yet — run `/join` first.');
  const current = airportsOf(m);

  switch (sub) {
    case 'list':
      return ok(
        current.length
          ? `Your airports: ${current.join(', ')}`
          : 'No airports on file. Add one with `/airports add`.',
        {
          ephemeral: true,
        },
      );
    case 'add': {
      const r = parseIata(str(opts, 'iata'), 'Airport');
      if ('error' in r) return oops(r.error);
      if (current.includes(r.code))
        return oops(`${r.code} is already on your list (${current.join(', ')}).`);
      setAirports(ctx.db, m, [...current, r.code]);
      return ok(`Added ${r.code}. Your airports: ${[...current, r.code].join(', ')}`);
    }
    case 'remove': {
      const r = parseIata(str(opts, 'iata'), 'Airport');
      if ('error' in r) return oops(r.error);
      if (!current.includes(r.code))
        return oops(`${r.code} isn't on your list (${current.join(', ') || 'empty'}).`);
      const next = current.filter((a) => a !== r.code);
      setAirports(ctx.db, m, next);
      return ok(`Removed ${r.code}. Your airports: ${next.join(', ') || 'none'}`);
    }
    default:
      return oops('Usage: `/airports add|remove <IATA>` or `/airports list`.');
  }
}

function flight(sub: string | null, opts: CommandOpts, ctx: CommandContext): CommandResult {
  const { db, now, user } = ctx;

  if (sub === 'list') {
    const rows = db
      .prepare(
        `SELECT f.*, m.name AS member_name FROM flights f
         JOIN members m ON m.id = f.member_id
         WHERE f.date >= ? ORDER BY f.date, m.name`,
      )
      .all(isoDay(now)) as (FlightRow & { member_name: string })[];
    if (rows.length === 0) return ok('No upcoming flights on file. Add yours with `/flight add`.');
    const lines = rows.map(
      (r) =>
        `${String(r.id).padStart(3)}  ${r.date}  ${r.member_name.padEnd(8)} ${(r.airline + r.number).padEnd(7)} ${r.origin}→${r.dest}` +
        (r.last_status ? `  ${r.last_status}` : ''),
    );
    return ok('```\n id  date        who      flight  route\n' + lines.join('\n') + '\n```');
  }

  const m = memberFor(db, user.id);
  if (!m) return oops('You are not on the roster yet — run `/join` first, then add your flight.');

  if (sub === 'add') {
    const airline = (str(opts, 'airline') ?? '').toUpperCase();
    if (!/^[A-Z0-9]{2,3}$/.test(airline))
      return oops(`Airline should be a 2–3 character IATA code like UA, not "${airline}".`);
    const number = (str(opts, 'number') ?? '').replace(/^0+(?=\d)/, '');
    if (!/^\d{1,4}$/.test(number))
      return oops(`Flight number should be digits only, not "${str(opts, 'number') ?? ''}".`);
    const date = str(opts, 'date') ?? '';
    if (!isRealDate(date)) return oops(`Date should be YYYY-MM-DD, not "${date}".`);
    if (date < isoDay(now)) return oops(`${date} is in the past.`);
    const origin = parseIata(str(opts, 'origin'), 'Origin');
    if ('error' in origin) return oops(origin.error);
    const dest = parseIata(str(opts, 'dest'), 'Destination');
    if ('error' in dest) return oops(dest.error);

    try {
      const res = db
        .prepare(
          'INSERT INTO flights (member_id, airline, number, date, origin, dest) VALUES (?,?,?,?,?,?)',
        )
        .run(m.id, airline, number, date, origin.code, dest.code);
      return ok(
        `Added ${airline}${number} ${origin.code}→${dest.code} on ${date} for ${m.name} (id ${res.lastInsertRowid}).`,
      );
    } catch (err) {
      if (String(err).includes('UNIQUE'))
        return oops(`${airline}${number} on ${date} is already on your list.`);
      throw err;
    }
  }

  if (sub === 'remove') {
    const id = Number(opts.id);
    if (!Number.isInteger(id))
      return oops('Usage: `/flight remove <id>` — ids are in `/flight list`.');
    const row = db.prepare('SELECT * FROM flights WHERE id = ?').get(id) as FlightRow | undefined;
    if (!row) return oops(`No flight with id ${id}.`);
    if (row.member_id !== m.id)
      return oops(`Flight ${id} isn't yours — only the owner can remove it.`);
    db.prepare('DELETE FROM flights WHERE id = ?').run(id);
    return ok(`Removed ${row.airline}${row.number} on ${row.date}.`);
  }

  return oops(
    'Usage: `/flight add <airline> <number> <date> <origin> <dest>`, `/flight remove <id>`, `/flight list`.',
  );
}

/**
 * The anchor (Packet 5) owns the Aspen status. If it has left a copy of the
 * rendered text in kv under an `anchor:` key we echo it; otherwise the
 * integrator gets the `trip` action and can fetch the live message. A bare
 * snowflake under that prefix is the message id, not content, so it's skipped.
 */
function trip(ctx: CommandContext): CommandResult {
  const rows = ctx.db
    .prepare(`SELECT value FROM kv WHERE key LIKE 'anchor:%' ORDER BY updated_at DESC, key`)
    .all() as { value: string }[];
  const content = rows
    .map((r) => r.value)
    .find((v) => v.trim().length > 0 && !/^\d{15,22}$/.test(v.trim()));
  return ok(content ?? 'no status yet', { action: { kind: 'trip' } });
}

function build(opts: CommandOpts, ctx: CommandContext): CommandResult {
  const destination = str(opts, 'destination')?.toLowerCase() || undefined;
  const month = str(opts, 'month') || undefined;
  if (destination && !ctx.cfg.board.some((d) => d.id === destination)) {
    const ids = ctx.cfg.board.map((d) => d.id).join(', ');
    return oops(`"${destination}" isn't on the board. Try one of: ${ids}.`);
  }
  if (month && !ISO_MONTH.test(month)) return oops(`Month should be YYYY-MM, not "${month}".`);
  const what = destination ? `a ${destination} plan` : 'the best plan on the board';
  return ok(`Building ${what}${month ? ` for ${month}` : ''} — this takes a few minutes.`, {
    action: { kind: 'build', ...(destination ? { destination } : {}), ...(month ? { month } : {}) },
  });
}

function setWatch(
  opts: CommandOpts,
  ctx: CommandContext,
  to: 'watched' | 'proposed',
): CommandResult {
  const id = str(opts, 'id') ?? '';
  if (!id) return oops('Usage: `/watch <id>` — the id is at the bottom of the dossier.');
  const from = to === 'watched' ? 'proposed' : 'watched';
  const row = ctx.db
    .prepare('SELECT id, destination, status FROM expeditions WHERE id = ?')
    .get(id) as { id: string; destination: string; status: string } | undefined;
  if (!row) return oops(`No expedition called "${id}".`);
  if (row.status !== from) {
    const why =
      row.status === 'retired'
        ? 'its window has passed'
        : row.status === to
          ? `it's already ${to}`
          : `it's ${row.status}, not ${from}`;
    return oops(`Can't ${to === 'watched' ? 'watch' : 'unwatch'} ${id} — ${why}.`);
  }
  ctx.db.prepare('UPDATE expeditions SET status = ? WHERE id = ?').run(to, id);
  return to === 'watched'
    ? ok(
        `Watching **${id}** (${row.destination}) — daily fare checks in its thread, a ping only on a ±10% move or a new floor.`,
      )
    : ok(`Stopped watching **${id}**.`);
}

function quiet(opts: CommandOpts, ctx: CommandContext): CommandResult {
  const raw = Number(opts.days);
  if (!Number.isFinite(raw)) return oops(`Usage: \`/quiet <days>\` (1–${QUIET_MAX_DAYS}).`);
  const days = Math.min(QUIET_MAX_DAYS, Math.max(1, Math.round(raw)));
  const until = new Date(ctx.now.getTime() + days * 86_400_000);
  kvSet(ctx.db, 'quiet_until', until.toISOString());
  return ok(
    `Quiet until ${isoDay(until)} (${days} day${days === 1 ? '' : 's'}). Urgent posts still get through.`,
  );
}

/* ------------------------------------------------------------- dispatch */

export async function handle(
  name: string,
  sub: string | null,
  opts: CommandOpts,
  ctx: CommandContext,
): Promise<CommandResult> {
  switch (name) {
    case 'join':
      return join(ctx);
    case 'airports':
      return airports(sub, opts, ctx);
    case 'flight':
      return flight(sub, opts, ctx);
    case 'trip':
      return trip(ctx);
    case 'build':
      return build(opts, ctx);
    case 'watch':
      return setWatch(opts, ctx, 'watched');
    case 'unwatch':
      return setWatch(opts, ctx, 'proposed');
    case 'quiet':
      return quiet(opts, ctx);
    default:
      return oops(`Unknown command /${name}.`);
  }
}

/* ---------------------------------------------------------- registration */

/**
 * Guild-scoped registration: instant, and scoped to the one guild we mean, so
 * a test run can never put commands in front of the real group by accident.
 */
export async function registerCommands(args: {
  token: string;
  appId: string;
  guildId: string;
}): Promise<number> {
  const rest = new REST({ version: '10' }).setToken(args.token);
  const body = COMMANDS.map((c) => c.toJSON());
  const result = (await rest.put(Routes.applicationGuildCommands(args.appId, args.guildId), {
    body,
  })) as unknown[];
  return result.length;
}

/* ------------------------------------------------------ discord plumbing */

export type InteractionDeps = {
  db: DB;
  cfg: Config;
  /** Runs the returned action; whatever it resolves to replaces the reply. */
  onAction?: (action: CommandAction, ctx: CommandContext) => Promise<string | undefined>;
  now?: () => Date;
};

/** Flatten interaction options (one level of subcommand) into the shape `handle()` takes. */
function optionsOf(interaction: ChatInputCommandInteraction): {
  sub: string | null;
  opts: CommandOpts;
} {
  const opts: CommandOpts = {};
  let sub: string | null = null;
  let data = interaction.options.data;
  const first = data[0];
  if (first && first.type === ApplicationCommandOptionType.Subcommand) {
    sub = first.name;
    data = first.options ?? [];
  }
  for (const o of data) {
    if (typeof o.value === 'string' || typeof o.value === 'number') opts[o.name] = o.value;
  }
  return { sub, opts };
}

export function attachInteractionHandler(client: Client, deps: InteractionDeps): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const ctx: CommandContext = {
      db: deps.db,
      cfg: deps.cfg,
      now: deps.now ? deps.now() : new Date(),
      user: {
        id: interaction.user.id,
        name:
          interaction.member && 'displayName' in interaction.member
            ? interaction.member.displayName
            : interaction.user.displayName,
      },
    };
    const { sub, opts } = optionsOf(interaction);
    try {
      const result = await handle(interaction.commandName, sub, opts, ctx);
      const flags = result.ephemeral ? MessageFlags.Ephemeral : undefined;
      if (result.action && deps.onAction) {
        // Builds take minutes; acknowledge now, edit the reply when done.
        await interaction.deferReply(flags ? { flags } : {});
        const out = await deps.onAction(result.action, ctx);
        await interaction.editReply(out ?? result.reply);
      } else {
        await interaction.reply(
          flags ? { content: result.reply, flags } : { content: result.reply },
        );
      }
    } catch (err) {
      log.error('slash command failed', { command: interaction.commandName, error: String(err) });
      const msg = 'Something broke handling that — check the logs.';
      if (interaction.deferred || interaction.replied)
        await interaction.editReply(msg).catch(() => {});
      else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
}
