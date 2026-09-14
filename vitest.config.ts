import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // No live network in CI. Sources are tested against recorded fixtures.
    testTimeout: 10_000,
    env: { LOG_LEVEL: 'error', NODE_ENV: 'test' },
  },
});
