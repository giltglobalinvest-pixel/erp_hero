import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT_DIR } from './helpers/context.js';

// Airtable ids (bases app…, tables tbl…, fields fld…, views viw…) are the prefix plus 14 letters and digits.
// Real ones look random. The placeholders in docs and tests don't: upper case and digits, or few distinct characters.
// The scan walks the filesystem, not git, so it also runs in a `git archive` copy.
// A hit is reported as "path:line" only, so a failing run never prints an id.
const ID = /\b(?:app|tbl|fld|viw)([A-Za-z0-9]{14})\b/g;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist']);

const looksReal = (tail: string): boolean => /[a-z]/.test(tail) && /[A-Z]/.test(tail) && new Set(tail).size >= 10;

// Line numbers (1-based) that hold at least one real-looking id.
const lineHits = (text: string): number[] =>
  text.split('\n').flatMap((line, i) => ([...line.matchAll(ID)].some((m) => looksReal(m[1] ?? '')) ? [i + 1] : []));

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
}

// The root pages and docs, sw.js and .env.example, and everything under docs/, server/ and test/.
function scannedFiles(): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(ROOT_DIR, { withFileTypes: true })) {
    if (entry.isFile() && (/\.(md|html)$/.test(entry.name) || entry.name === 'sw.js' || entry.name === '.env.example')) {
      files.push(path.join(ROOT_DIR, entry.name));
    }
  }
  for (const dir of ['docs', 'server', 'test']) walk(path.join(ROOT_DIR, dir), files);
  return files;
}

const rel = (file: string): string => path.relative(ROOT_DIR, file).split(path.sep).join('/');

describe('repo hygiene: no real Airtable ids in the tree', () => {
  it('tells a random-looking id from a placeholder', () => {
    const text = [
      'no id here',
      'base: ' + 'app' + 'AbCdEfGhIjKlMn' + ', table tbl…',
      'placeholders: ' + ['app' + 'TEST0000000001', 'app' + 'ABCDEFGHIJKLMN', 'tbl' + 'abcdefghijklmn', 'fld' + 'AaBbAaBbAaBbAa'].join(' '),
      'too long or glued on: ' + 'app' + 'AbCdEfGhIjKlMnO' + ' x' + 'viw' + 'AbCdEfGhIjKlMn',
      'in a URL: https://airtable.com/' + 'app' + 'Ab1Cd2Ef3Gh4Ij' + '/' + 'tbl' + 'Ab1Cd2Ef3Gh4Ij',
    ].join('\n');
    expect(lineHits(text)).toEqual([2, 5]);
  });

  it('scans the root pages and docs, sw.js, .env.example, docs/, server/ and test/', () => {
    const files = scannedFiles().map(rel);
    expect(files).toEqual(
      expect.arrayContaining([
        'index.html',
        'loader.html',
        'loader-admin.html',
        'sw.js',
        '.env.example',
        'DEPLOY.md',
        'README.md',
        'docs/superpowers/plans/2026-09-25-erp-hero-backend.md',
        'docs/superpowers/plans/2026-09-28-erp-hero-frontend-switch.md',
        'server/import/importer.ts',
        'test/importer.test.ts',
      ]),
    );
    expect(files.filter((f) => f.split('/').some((part) => SKIP_DIRS.has(part)))).toEqual([]);
    expect(files.length).toBeGreaterThan(50);
  });

  it('finds no base, table, field or view id that looks real', () => {
    const hits: string[] = [];
    for (const file of scannedFiles()) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\0')) continue; // not a text file
      for (const n of lineHits(text)) hits.push(`${rel(file)}:${n}`);
    }
    expect(hits).toEqual([]);
  });
});
