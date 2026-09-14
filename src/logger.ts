/** Dependency-free structured logger. One JSON line per event in production,
 *  something readable in a terminal otherwise. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
export type Level = keyof typeof LEVELS;

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
const pretty = process.env.NODE_ENV !== 'production';

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const at = new Date().toISOString();
  if (pretty) {
    const tail = fields && Object.keys(fields).length ? ` ${JSON.stringify(fields)}` : '';
    console.log(`${at} ${level.toUpperCase().padEnd(5)} ${msg}${tail}`);
  } else {
    console.log(JSON.stringify({ at, level, msg, ...fields }));
  }
}

export type Logger = {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bound: Record<string, unknown>): Logger;
};

export const log: Logger = {
  debug: (m: string, f?: Record<string, unknown>) => emit('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => emit('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => emit('error', m, f),
  child(bound: Record<string, unknown>): Logger {
    const bind = (level: Level) => (m: string, f?: Record<string, unknown>) =>
      emit(level, m, { ...bound, ...f });
    return {
      debug: bind('debug'),
      info: bind('info'),
      warn: bind('warn'),
      error: bind('error'),
      child: (more) => log.child({ ...bound, ...more }),
    };
  },
};
