/**
 * `files.ts` unit tests. Uses a real tmp directory rather than
 * mocking fs — fewer mocks, sharper signal when something regresses.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IGNORE, parseIgnoreInput, walkSourceTree } from '../src/files.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'deploy-fn-files-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const abs = join(root, rel);
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  if (dir.length > root.length) mkdirSync(dir, { recursive: true });
  writeFileSync(abs, contents);
}

describe('parseIgnoreInput', () => {
  it('returns [] for undefined / empty', () => {
    expect(parseIgnoreInput(undefined)).toEqual([]);
    expect(parseIgnoreInput('')).toEqual([]);
    expect(parseIgnoreInput('   \n  ')).toEqual([]);
  });
  it('splits on newlines and trims', () => {
    expect(parseIgnoreInput('  foo\nbar  \n  baz')).toEqual(['foo', 'bar', 'baz']);
  });
  it('drops `#` comments and blank lines', () => {
    expect(parseIgnoreInput('# header\nfoo\n\n# inline\nbar')).toEqual(['foo', 'bar']);
  });
});

describe('walkSourceTree — happy path', () => {
  it('collects package.json + sources with POSIX-style paths', () => {
    write('package.json', '{"name":"test"}');
    write('src/index.ts', 'export default 1');
    write('src/lib/util.ts', 'export const x = 1');
    const result = walkSourceTree(root);
    expect(Object.keys(result.files).sort()).toEqual([
      'package.json',
      'src/index.ts',
      'src/lib/util.ts',
    ]);
    expect(result.files['src/index.ts']).toBe('export default 1');
    expect(result.fileCount).toBe(3);
    expect(result.totalBytes).toBeGreaterThan(0);
  });

  it('applies the default ignore list (node_modules, .git, dist, …)', () => {
    write('package.json', '{}');
    write('src/index.ts', 'x');
    write('node_modules/foo/index.js', 'should not appear');
    write('.git/HEAD', 'ref');
    write('dist/handler.js', 'built');
    write('coverage/lcov.info', 'TN:');
    const result = walkSourceTree(root);
    expect(Object.keys(result.files).sort()).toEqual(['package.json', 'src/index.ts']);
  });

  it('default ignore covers the .env.* family (production, staging, etc)', () => {
    write('package.json', '{}');
    write('src/index.ts', 'x');
    write('.env', 'A=1');
    write('.env.local', 'A=1');
    write('.env.production', 'A=1');
    write('.env.staging', 'A=1');
    const result = walkSourceTree(root);
    expect(Object.keys(result.files).sort()).toEqual(['package.json', 'src/index.ts']);
  });

  it('layers caller ignore patterns on top of defaults', () => {
    write('package.json', '{}');
    write('src/index.ts', 'x');
    write('docs/README.md', 'docs');
    write('src/secret.log', 'leak');
    const result = walkSourceTree(root, { ignore: ['docs', '*.log'] });
    expect(Object.keys(result.files).sort()).toEqual(['package.json', 'src/index.ts']);
  });

  it('glob patterns are anchored basename matches', () => {
    write('package.json', '{}');
    write('src/util.ts', 'x');
    write('src/util.test.ts', 'test');
    write('src/util.spec.ts', 'spec');
    const result = walkSourceTree(root, { ignore: ['*.test.ts', '*.spec.ts'] });
    expect(Object.keys(result.files).sort()).toEqual(['package.json', 'src/util.ts']);
  });
});

describe('walkSourceTree — symlink handling', () => {
  it('fails loudly when a symlinked file is encountered', async () => {
    write('package.json', '{}');
    write('real.ts', 'x');
    const { symlinkSync } = await import('node:fs');
    symlinkSync(join(root, 'real.ts'), join(root, 'link.ts'));
    expect(() => walkSourceTree(root)).toThrow(
      /is a symbolic link, which managed build cannot follow safely/,
    );
  });
});

describe('walkSourceTree — glob matching edge cases', () => {
  it('treats `?` literally (not as a wildcard) in exact-name patterns', () => {
    write('package.json', '{}');
    write('xy.ts', 'x');
    write('?.ts', 'literal');
    // `?.ts` matches ONLY the literal-named file, not `xy.ts`.
    const result = walkSourceTree(root, { ignore: ['?.ts'] });
    expect(Object.keys(result.files).sort()).toEqual(['package.json', 'xy.ts']);
  });

  it('does not let `*`→`.*` regex chars interact with literal segments', () => {
    write('package.json', '{}');
    write('foo.bar', 'x');
    write('fooXbar', 'y');
    // `foo.*` should match `foo.bar` (the `.` is a literal dot, the
    // `*` is the wildcard); `fooXbar` does NOT have a dot so must NOT
    // match.
    const result = walkSourceTree(root, { ignore: ['foo.*'] });
    expect(Object.keys(result.files).sort()).toEqual(['fooXbar', 'package.json']);
  });
});

describe('walkSourceTree — validation', () => {
  it('throws if files-path is not a directory', () => {
    writeFileSync(join(root, 'not-a-dir'), 'x');
    expect(() => walkSourceTree(join(root, 'not-a-dir'))).toThrow(/is not a directory/);
  });

  it('throws if no package.json at the root', () => {
    write('src/index.ts', 'x');
    expect(() => walkSourceTree(root)).toThrow(/must contain a package\.json at the root/);
  });

  it('refuses binary content (NUL byte) with a clear message', () => {
    write('package.json', '{}');
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x01, 0x00, 0x02]));
    expect(() => walkSourceTree(root)).toThrow(/binary file/);
  });

  it('enforces maxFiles cap', () => {
    write('package.json', '{}');
    for (let i = 0; i < 5; i++) write(`src/f${i}.ts`, 'x');
    expect(() => walkSourceTree(root, { maxFiles: 3 })).toThrow(/too many source files/);
  });

  it('enforces maxTotalBytes cap', () => {
    write('package.json', '{}');
    write('big.ts', 'x'.repeat(200));
    expect(() =>
      walkSourceTree(root, { maxTotalBytes: 100 }),
    ).toThrow(/exceeds 100 bytes/);
  });
});

describe('DEFAULT_IGNORE', () => {
  it('includes the standard build/VCS/secret entries', () => {
    for (const expected of ['node_modules', '.git', 'dist', '.env']) {
      expect(DEFAULT_IGNORE).toContain(expected);
    }
  });
});
