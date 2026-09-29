import { defineConfig } from 'vitest/config';

// Browser end-to-end suite: real index.html in headless Chromium against an in-process backend.
export default defineConfig({
  test: {
    include: ['test/e2e/**/*.e2e.ts'],
    setupFiles: ['test/setup.ts'],
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
