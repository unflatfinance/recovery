import { defineConfig } from 'vitest/config';

// Chain and UI tests hit the public Base RPC (rate limited): run files one at
// a time and give each test time for a few round trips.
export default defineConfig({
  test: { testTimeout: 60_000, hookTimeout: 60_000, fileParallelism: false },
});
