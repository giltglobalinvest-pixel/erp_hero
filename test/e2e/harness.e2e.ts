import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startHarness } from './harness.js';

// Listening servers in this process: the harness starts one before it launches the browser.
const servers = (): number => process.getActiveResourcesInfo().filter((r) => r === 'TCPServerWrap').length;

describe('harness: a failed start leaves nothing behind', () => {
  it('startHarness rejects when Chromium cannot start, closes its server and removes its temp data dir', async () => {
    // A temp dir of its own: os.tmpdir() reads TMPDIR on every call, so the harness puts its data dir in here.
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'erp-harness-test-'));
    const saved = { TMPDIR: process.env.TMPDIR, CHROMIUM_PATH: process.env.CHROMIUM_PATH };
    process.env.TMPDIR = tmp;
    // A path that does not exist: nothing is installed or downloaded.
    process.env.CHROMIUM_PATH = path.join(tmp, 'no-such-chromium');
    const serversBefore = servers();
    try {
      await expect(startHarness()).rejects.toThrow(/executable doesn't exist/i);
      // Playwright itself leaves its playwright-artifacts-* and playwright_chromiumdev_profile-* dirs behind
      // when the executable is missing (playwright-core lib/server/browserType.js, _prepareToLaunch).
      // They are not the harness's.
      const left = (await readdir(tmp)).filter((name) => !/^playwright[-_]/.test(name));
      expect({ left, servers: servers() }).toEqual({ left: [], servers: serversBefore });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
