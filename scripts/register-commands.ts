/**
 * Registers the slash commands with Discord, guild-scoped.
 *
 *   pnpm tsx scripts/register-commands.ts              # test guild (default)
 *   pnpm tsx scripts/register-commands.ts --guild real # the group's guild
 *
 * Guild commands appear instantly; global ones take up to an hour and would
 * show up in every server the bot is in, so we never use them. Re-running
 * replaces the whole set for that guild — removed commands disappear.
 */
import '../src/env.js'; // must come first: reads .env into process.env
import { assertSnowflake, loadConfig, requireSecret } from '../src/config.js';
import { COMMANDS, registerCommands } from '../src/discord/commands.js';

const args = process.argv.slice(2);
const flagIdx = args.indexOf('--guild');
const target =
  args.find((a) => a.startsWith('--guild='))?.slice('--guild='.length) ??
  (flagIdx >= 0 ? args[flagIdx + 1] : 'test');
if (target !== 'test' && target !== 'real') {
  console.error(`--guild must be "test" or "real", got "${target}"`);
  process.exit(1);
}

const cfg = loadConfig();
const guildIdEnv =
  target === 'real' ? cfg.discord.guild_id_env : cfg.discord.test_guild_id_env;
const guildId = cfg.channels[target].guildId;
if (!guildId) {
  console.error(`no guild id for "${target}" — set ${guildIdEnv} in .env`);
  process.exit(1);
}
try {
  assertSnowflake(guildId, guildIdEnv);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const n = await registerCommands({
  token: requireSecret('DISCORD_BOT_TOKEN'),
  appId: requireSecret('DISCORD_APP_ID'),
  guildId,
});
console.log(
  `registered ${n} commands in ${target} guild ${guildId}: ${COMMANDS.map((c) => '/' + c.name).join(' ')}`,
);
