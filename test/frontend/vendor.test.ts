// test/frontend/vendor.test.ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string): Buffer => readFileSync(path.join(ROOT, file));
// The vendored DOMPurify (vendor/README.md). Raise it together with the file, the README and the integrity pin.
const VERSION = '3.4.16';

// Assertions are booleans on purpose: a failing toContain would print the whole file.
describe('vendor/purify.min.js', () => {
  const file = read('vendor/purify.min.js');
  const integrity = `sha384-${createHash('sha384').update(file).digest('base64')}`;
  const html = read('index.html').toString('utf8');
  const readme = read('vendor/README.md').toString('utf8');

  it('its sha384 is the integrity of its script tag in index.html and the value in vendor/README.md', () => {
    const tag = `<script src="vendor/purify.min.js" integrity="${integrity}"></script>`;
    expect(html.split(tag).length - 1).toBe(1);
    // No second tag loads it, pinned or not.
    expect([...html.matchAll(/<script\b[^>]*purify/g)].length).toBe(1);
    expect(readme.includes(`\`${integrity}\``)).toBe(true);
  });

  it(`is DOMPurify ${VERSION}`, () => {
    expect(file.subarray(0, 64).toString('utf8').startsWith(`/*! @license DOMPurify ${VERSION} `)).toBe(true);
    expect(readme.includes(`## DOMPurify ${VERSION}\n`)).toBe(true);
  });

  it('is loaded right after the GitHub Pages guard, before every other script', () => {
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)];
    const guard = scripts[0];
    const next = scripts[1];
    expect(guard?.[0]).toBe('<script>');
    const guardEnd = html.indexOf('</script>', guard?.index ?? 0);
    expect(html.slice(guard?.index ?? 0, guardEnd).includes('github\\.io')).toBe(true);
    expect(next?.[0]).toBe(`<script src="vendor/purify.min.js" integrity="${integrity}">`);
    expect(/^\s*$/.test(html.slice(guardEnd + '</script>'.length, next?.index ?? 0))).toBe(true);
  });
});
