#!/usr/bin/env node
/**
 * Lint guard: refuses to merge if the committed `dist/index.js` is
 * not the bundled output of the current `src/`.
 *
 * GitHub Actions consume `dist/index.js` directly at runtime (no
 * build step inside the action runtime), so the committed bundle
 * MUST match `src/`. A drifted dist means external consumers run
 * a different code path than the source tree shows.
 *
 * Strategy: copy the committed `dist/` to a temp dir, rebuild, diff
 * against the original. Any difference fails the check.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(PKG_ROOT, 'dist', 'index.js');

if (!existsSync(distIndex)) {
  console.error('dist/index.js does not exist. Run `pnpm build` first and commit the result.');
  process.exit(1);
}

const stash = mkdtempSync(join(tmpdir(), 'deploy-fn-dist-'));
copyFileSync(distIndex, join(stash, 'index.js.committed'));

execSync('pnpm build', { cwd: PKG_ROOT, stdio: 'inherit' });

const committed = readFileSync(join(stash, 'index.js.committed'), 'utf8');
const rebuilt = readFileSync(distIndex, 'utf8');
rmSync(stash, { recursive: true, force: true });

if (committed !== rebuilt) {
  console.error('dist/index.js is out of sync with src/. Run `pnpm build` and commit the result.');
  // Hint the first ~120 chars of divergence to help diagnose.
  const firstDiff = (() => {
    const max = Math.min(committed.length, rebuilt.length);
    for (let i = 0; i < max; i++) {
      if (committed[i] !== rebuilt[i]) return i;
    }
    return max;
  })();
  console.error(`first diverging char at index ${firstDiff}`);
  console.error('committed:', committed.slice(firstDiff, firstDiff + 120));
  console.error('rebuilt:  ', rebuilt.slice(firstDiff, firstDiff + 120));
  process.exit(1);
}

console.log('dist/index.js matches src/. OK.');
