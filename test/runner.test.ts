import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/jobs/_runner.js';

const argv = (...rest: string[]) => ['node', 'index.js', ...rest];

describe('parseArgs', () => {
  it('reads job, dry-run and channel', () => {
    expect(parseArgs(argv('job=noop', '--dry-run', '--channel', 'test'), {})).toEqual({
      job: 'noop',
      dryRun: true,
      target: 'test',
    });
  });

  it('accepts --channel=real', () => {
    expect(parseArgs(argv('job=noop', '--channel=real'), {}).target).toBe('real');
  });

  it('defaults to the test channel, never the live one', () => {
    expect(parseArgs(argv('job=noop'), {}).target).toBe('test');
  });

  it('lets the environment set the default channel for the deployed container', () => {
    expect(parseArgs(argv('job=noop'), { SNOWBOT_CHANNEL: 'real' }).target).toBe('real');
  });

  it('lets an explicit flag beat the environment', () => {
    expect(parseArgs(argv('job=noop', '--channel', 'test'), { SNOWBOT_CHANNEL: 'real' }).target).toBe('test');
  });

  it('takes a bare job name', () => {
    expect(parseArgs(argv('noop', '--dry-run'), {}).job).toBe('noop');
  });

  it('parses an injected clock', () => {
    expect(parseArgs(argv('job=noop', '--now=2027-01-25T08:00:00Z'), {}).now?.toISOString()).toBe(
      '2027-01-25T08:00:00.000Z',
    );
  });

  it('rejects nonsense', () => {
    expect(() => parseArgs(argv('--dry-run'), {})).toThrow(/no job given/);
    expect(() => parseArgs(argv('job=noop', '--channel', 'prod'), {})).toThrow(/must be "test" or "real"/);
    expect(() => parseArgs(argv('job=noop', '--now=banana'), {})).toThrow(/is not a date/);
  });
});
