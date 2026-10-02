// test/frontend/quill-version.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (file: string): string => readFileSync(path.join(ROOT, file), 'utf8');

// The app loads Quill from jsDelivr. The real-editor e2e tests (test/e2e/editor-lists.e2e.ts) serve
// node_modules/quill at those URLs instead, so the test-only devDependency must be the same version.
describe('Quill, the test-only devDependency', () => {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const pinned = pkg.devDependencies?.quill;
  const html = read('index.html');
  const urls = [...html.matchAll(/https:\/\/cdn\.jsdelivr\.net\/npm\/quill@([^/'"`\s]+)\/dist\//g)];

  it('is pinned to an exact version, as a devDependency only, and is the version installed', () => {
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies?.quill).toBeUndefined();
    const installed = (JSON.parse(read('node_modules/quill/package.json')) as { version: string }).version;
    expect(installed).toBe(pinned);
  });

  it('has the version of every quill@… jsDelivr URL in index.html', () => {
    // Every quill@ in the file is one of these URLs, so none is left out of the comparison.
    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(html.split('quill@').length - 1).toBe(urls.length);
    expect([...new Set(urls.map((m) => m[1]))]).toEqual([pinned]);
  });
});
