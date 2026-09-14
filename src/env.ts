/**
 * Side-effect module: importing it reads `.env` into `process.env`.
 *
 * Nothing else in the tree does this. In the container docker compose injects
 * the same variables through `env_file:`, but a shell has no such help, so
 * anything run by hand — `src/index.ts`, everything in `scripts/` — must
 * import this FIRST, before any module that reads `process.env` while it is
 * being imported (`logger.ts` does).
 *
 * Node's own parser is deliberate on two counts: a variable already present in
 * the real environment is never overwritten, so `FOO=bar pnpm …` still wins;
 * and a trailing `# comment` is stripped, which docker compose's `env_file`
 * does not do (see `stripInlineComment` in config.ts for the other half).
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Returns the file it read, or undefined when there was nothing to read. */
export function loadEnv(path = process.env.SNOWBOT_ENV_FILE ?? '.env'): string | undefined {
  const file = resolve(path);
  if (!existsSync(file)) return undefined;
  process.loadEnvFile(file);
  return file;
}

loadEnv();
