import { beforeEach } from 'vitest';

// Any real network call from a test is a bug: all upstream HTTP must go through FakeFetch.
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    throw new Error(`Live network access is disabled in tests (attempted: ${String(input)})`);
  }) as typeof fetch;
});
