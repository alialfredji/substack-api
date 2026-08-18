import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Live-API tests are opt-in: SUBSTACK_LIVE=1 npm test
    testTimeout: process.env['SUBSTACK_LIVE'] === '1' ? 30_000 : 10_000,
  },
});
