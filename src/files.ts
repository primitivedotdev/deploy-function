/**
 * Managed-build file collection.
 *
 * Walks a source directory and produces the `{relativePath: contents}`
 * map the platform's managed-build path expects. Mirrors the server's
 * limits (`MANAGED_BUILD_LIMITS` in @primitivedotdev/control-plane-core)
 * client-side so the action fails fast before the API call:
 *
 *   - max 100 files
 *   - total UTF-8 byte size <= 64 MB (the CF Worker raw-size cap)
 *   - package.json MUST be present
 *   - no leading slash, no `..`, no `.` as a path
 *
 * Default ignore list covers the usual build outputs + VCS metadata
 * so a developer can point at the package root without thinking. The
 * caller can override or extend via the `ignore` input.
 *
 * Binary file handling: source files for managed build must be UTF-8
 * text. We detect non-UTF-8 content (NUL byte present after decode)
 * and refuse to include it, with a clear error pointing at the
 * specific file. Users who genuinely need binary assets bundle them
 * via the pre-built `code` path instead.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SERVER_MAX_FILES = 100;
const SERVER_MAX_TOTAL_BYTES = 64_000_000;

export const DEFAULT_IGNORE: readonly string[] = [
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  '.next',
  '.turbo',
  '.vercel',
  'coverage',
  '.DS_Store',
  '.env',
  '.env.local',
  // Covers .env.production, .env.staging, .env.development, .env.test, etc.
  '.env.*',
];

export interface WalkOptions {
  /** Additional ignore patterns appended to DEFAULT_IGNORE. */
  ignore?: readonly string[];
  /** Override the default 100 — server still caps at 100 regardless. */
  maxFiles?: number;
  /** Override the default 64 MB — server still caps regardless. */
  maxTotalBytes?: number;
}

export interface WalkResult {
  files: Record<string, string>;
  totalBytes: number;
  fileCount: number;
}

/**
 * Walk `rootPath` recursively and collect every readable text file
 * into a `{relativePath: contents}` map. Paths use POSIX-style `/`
 * separators (what the platform contract expects) regardless of the
 * host filesystem.
 *
 * Throws (rather than warns) on cap violations and on binary content:
 * a failed deploy at the action layer is preferable to a confusing
 * 400 from the server, and either outcome is fatal anyway.
 */
export function walkSourceTree(rootPath: string, opts: WalkOptions = {}): WalkResult {
  const ignore = matchersFrom([...DEFAULT_IGNORE, ...(opts.ignore ?? [])]);
  const maxFiles = opts.maxFiles ?? SERVER_MAX_FILES;
  const maxTotalBytes = opts.maxTotalBytes ?? SERVER_MAX_TOTAL_BYTES;
  const files: Record<string, string> = {};
  let totalBytes = 0;

  const stat = statSync(rootPath);
  if (!stat.isDirectory()) {
    throw new Error(`files-path "${rootPath}" is not a directory`);
  }

  const stack: string[] = [rootPath];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.some((m) => m(entry.name))) continue;
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // Fail loud rather than silently drop. Following symlinks
        // can escape rootPath or create cycles; the safe default is
        // to refuse and let the operator decide (replace with a real
        // copy or add to the `ignore` input).
        const rel = relative(rootPath, abs).split(sep).join('/');
        throw new Error(
          `"${rel}" is a symbolic link, which managed build cannot follow safely. ` +
          `Replace the symlink with a real copy of its target, or add the entry ` +
          `to the action's \`ignore\` input.`,
        );
      }
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = relative(rootPath, abs).split(sep).join('/');
      const contents = readFileBinarySafe(abs, rel);
      totalBytes += Buffer.byteLength(contents, 'utf8');
      files[rel] = contents;

      if (Object.keys(files).length > maxFiles) {
        throw new Error(
          `too many source files (max ${maxFiles}). ` +
          `Add directory or file patterns to the action's \`ignore\` input.`,
        );
      }
      if (totalBytes > maxTotalBytes) {
        throw new Error(
          `source tree exceeds ${maxTotalBytes} bytes after reading "${rel}". ` +
          `Trim assets or move binary content to a pre-built bundle (code-path).`,
        );
      }
    }
  }

  if (!Object.hasOwn(files, 'package.json')) {
    throw new Error(
      `files-path "${rootPath}" must contain a package.json at the root. ` +
      `Managed build needs a package.json (it may have empty dependencies).`,
    );
  }

  return { files, totalBytes, fileCount: Object.keys(files).length };
}

/**
 * Read a file as UTF-8 and verify it doesn't contain NUL bytes
 * (which would indicate a binary file the server can't accept).
 * Throws a clear error pointing at the offender.
 */
function readFileBinarySafe(absPath: string, relPath: string): string {
  const buf = readFileSync(absPath);
  // Quick binary heuristic — server rejects with a less actionable
  // error if we pass it through, so catch it here.
  if (buf.indexOf(0) !== -1) {
    throw new Error(
      `"${relPath}" appears to be a binary file (contains NUL bytes). ` +
      `Managed build accepts UTF-8 text only; either remove it from the source tree ` +
      `(add to the action's \`ignore\` input) or switch to code-path with a pre-built bundle.`,
    );
  }
  return buf.toString('utf8');
}

/**
 * Convert an ignore-list entry into a basename-matcher function.
 *
 * Supported patterns (intentionally minimal — gitignore semantics
 * are way more than the action needs):
 *   - exact basename: `node_modules`, `.git`
 *   - extension glob with `*`: `*.log`, `*.test.ts`, `tmp*`
 *
 * Matches are basename-only (anywhere in the tree), which is what
 * most users want for ignoring `node_modules` etc. We intentionally
 * do NOT support `?` — too easy to confuse with regex `.` and the
 * naïve chained-replace impl had ordering bugs. If sharper matching
 * is ever needed, pull in a real glob library.
 */
function matchersFrom(patterns: readonly string[]): Array<(name: string) => boolean> {
  return patterns.map((p) => {
    const trimmed = p.trim();
    if (trimmed === '') return () => false;
    if (!trimmed.includes('*')) {
      return (name) => name === trimmed;
    }
    // Build the regex in a single pass over the pattern so that
    // escaping the literal segments can't accidentally interact with
    // the glob translation.
    let re = '';
    for (const ch of trimmed) {
      if (ch === '*') {
        re += '.*';
      } else {
        re += ch.replace(/[.+^${}()|[\]\\?]/g, '\\$&');
      }
    }
    const compiled = new RegExp(`^${re}$`);
    return (name) => compiled.test(name);
  });
}

/**
 * Parse the `ignore` action input. Accepts either:
 *   - a newline-delimited string (one pattern per line), or
 *   - an empty/undefined value
 *
 * Comments (lines starting with `#`) and blank lines are dropped so
 * users can document their ignore list inline.
 */
export function parseIgnoreInput(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}
