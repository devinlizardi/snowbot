import cron from 'node-cron';
import { describe, expect, it, vi } from 'vitest';
import type { Job } from '../src/jobs/_runner.js';
import { log } from '../src/logger.js';
import { SCHEDULE, TIMEZONE, startScheduler, type ScheduleFn } from '../src/scheduler.js';

/** Every job name that exists or is planned in PLAN.md §5. */
const KNOWN_JOBS = ['noop', 'aspenUpdate', 'flightWatch', 'expeditionBuild', 'expeditionWatch'];

const fakeJob = (name: string): Job => ({ name, run: async () => {} });

function fakeCron() {
  const calls: { expression: string; name: string; timezone: string; tick: () => Promise<void> }[] =
    [];
  const schedule: ScheduleFn = (expression, tick, opts) => {
    calls.push({ expression, name: opts.name, timezone: opts.timezone, tick });
    return { stop: vi.fn() };
  };
  return { calls, schedule };
}

describe('SCHEDULE', () => {
  it('holds only valid cron expressions', () => {
    for (const [name, expr] of Object.entries(SCHEDULE)) {
      if (expr === null) continue;
      expect(cron.validate(expr), `${name}: ${expr}`).toBe(true);
      expect(expr.split(/\s+/), `${name} should be 5-field`).toHaveLength(5);
    }
  });

  it('names only known jobs', () => {
    for (const name of Object.keys(SCHEDULE)) expect(KNOWN_JOBS).toContain(name);
  });

  it('never puts noop on the clock and keeps the weekly build on Monday', () => {
    expect(SCHEDULE.noop).toBeNull();
    expect(SCHEDULE.expeditionBuild).toBe('0 8 * * 1');
    expect(TIMEZONE).toBe('America/New_York');
  });
});

describe('startScheduler', () => {
  it('registers exactly the jobs present and skips the rest', () => {
    const { calls, schedule } = fakeCron();
    const jobs = { noop: fakeJob('noop'), flightWatch: fakeJob('flightWatch') };
    const s = startScheduler(jobs, { env: {}, log, schedule });

    expect(s.scheduled).toEqual(['flightWatch']);
    expect(calls.map((c) => c.name)).toEqual(['flightWatch']);
    expect(calls[0]?.expression).toBe(SCHEDULE.flightWatch);
    expect(calls[0]?.timezone).toBe(TIMEZONE);
  });

  it('registers every scheduled job when all are present', () => {
    const { calls, schedule } = fakeCron();
    const jobs = Object.fromEntries(KNOWN_JOBS.map((n) => [n, fakeJob(n)]));
    startScheduler(jobs, { env: {}, log, schedule });
    const expected = Object.entries(SCHEDULE)
      .filter(([, e]) => e !== null)
      .map(([n]) => n);
    expect(calls.map((c) => c.name)).toEqual(expected);
  });

  it('passes dry-run and channel from the environment into each run', async () => {
    const { calls, schedule } = fakeCron();
    const run = vi.fn(async () => {});
    const job = fakeJob('aspenUpdate');
    startScheduler(
      { aspenUpdate: job },
      { env: { SNOWBOT_DRY_RUN: '1', SNOWBOT_CHANNEL: 'real' }, log, schedule, run },
    );
    await calls[0]?.tick();
    expect(run).toHaveBeenCalledWith(job, { job: 'aspenUpdate', dryRun: true, target: 'real' });
  });

  it('defaults to the test channel and a live (non-dry) run', async () => {
    const { calls, schedule } = fakeCron();
    const run = vi.fn(async () => {});
    const job = fakeJob('aspenUpdate');
    startScheduler({ aspenUpdate: job }, { env: {}, log, schedule, run });
    await calls[0]?.tick();
    expect(run).toHaveBeenCalledWith(job, { job: 'aspenUpdate', dryRun: false, target: 'test' });
  });

  it('swallows a failing run so the process survives', async () => {
    const { calls, schedule } = fakeCron();
    const run = vi.fn(async () => {
      throw new Error('boom');
    });
    startScheduler({ aspenUpdate: fakeJob('aspenUpdate') }, { env: {}, log, schedule, run });
    await expect(calls[0]?.tick()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('stop() stops every task it started', async () => {
    const stops: ReturnType<typeof vi.fn>[] = [];
    const schedule: ScheduleFn = () => {
      const stop = vi.fn();
      stops.push(stop);
      return { stop };
    };
    const jobs = Object.fromEntries(KNOWN_JOBS.map((n) => [n, fakeJob(n)]));
    const s = startScheduler(jobs, { env: {}, log, schedule });
    await s.stop();
    expect(stops).toHaveLength(s.scheduled.length);
    for (const stop of stops) expect(stop).toHaveBeenCalledTimes(1);
  });
});
