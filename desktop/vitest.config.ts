import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Generous so the in-memory E2E transfer stays reliable even under the
    // slower v8 coverage instrumentation on CI.
    testTimeout: 60000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'json-summary', 'lcov'],
      // Cover the runtime-agnostic core shared by all three clients — the
      // crypto, wire protocol, and transfer state machine that carry the risk.
      include: ['src/shared/**/*.ts'],
      exclude: ['src/shared/**/*.test.ts', 'src/shared/ipc.ts'],
    },
  },
});
