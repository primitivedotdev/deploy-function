#!/usr/bin/env node
/**
 * Local end-to-end driver for the bundled action.
 *
 * GitHub Actions feeds the action runtime via `INPUT_<NAME>` env
 * vars (see @actions/core); this script sets them in-process then
 * imports the bundled dist/index.js so the action runs exactly as
 * it would on a runner — but against real staging credentials.
 *
 * Usage:
 *   PRIMITIVE_API_KEY=... node scripts/run-local.mjs \
 *     --name zork \
 *     --code-path ../../apps/zork-function/dist/handler.js \
 *     --source-map-path ../../apps/zork-function/dist/handler.js.map \
 *     --api-base-url https://api.primitive-staging-1.com/v1
 *
 * Inputs that aren't supplied via flags fall through to action.yml
 * defaults (e.g. api-base-url defaults to prod). The api-key MUST
 * be in env — never on the command line where it could leak via
 * `ps`/history.
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

const apiKey = process.env.PRIMITIVE_API_KEY;
if (!apiKey) {
  console.error('PRIMITIVE_API_KEY env var is required');
  process.exit(1);
}

// Parse `--key value` pairs from argv into an object.
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) {
    console.error(`unexpected positional arg: ${a}`);
    process.exit(1);
  }
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next == null || next.startsWith('--')) {
    console.error(`flag --${key} requires a value`);
    process.exit(1);
  }
  args[key] = next;
  i++;
}

// @actions/core.getInput reads `INPUT_${name.toUpperCase().replace(/ /g,'_')}`.
// Dashes in names are preserved as-is in the env var name (yes, really).
function setInput(name, value) {
  if (value === undefined) return;
  process.env[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] = String(value);
}

setInput('api-key', apiKey);
setInput('name', args.name ?? 'zork');
if (args['code-path']) setInput('code-path', resolve(process.cwd(), args['code-path']));
if (args['source-map-path']) setInput('source-map-path', resolve(process.cwd(), args['source-map-path']));
if (args['files-path']) setInput('files-path', resolve(process.cwd(), args['files-path']));
if (args['api-base-url']) setInput('api-base-url', args['api-base-url']);
if (args['expected-org-id']) setInput('expected-org-id', args['expected-org-id']);
if (args.secrets) setInput('secrets', args.secrets);
if (args.ignore) setInput('ignore', args.ignore);
if (args['redeploy-on-secret-change']) setInput('redeploy-on-secret-change', args['redeploy-on-secret-change']);

console.error(`[run-local] inputs configured; invoking dist/index.js`);
await import(resolve(PKG_ROOT, 'dist', 'index.js'));
