/**
 * Deploy orchestration: the platform-shape independent algorithm
 * the Action runs once it has parsed inputs and read the bundle.
 *
 * Split out from `index.ts` so it's testable without an `@actions/core`
 * runtime (the unit tests inject a fake api + capture outputs through
 * a Logger seam).
 */

import { ApiError, api, type FunctionRow } from './api.js';
import type { Inputs } from './inputs.js';

/**
 * A list-result safety cap. The dedicated easter-egg orgs we deploy
 * into are expected to hold a handful of functions; a list larger
 * than this signals something is wrong (orphaned old deploys, wrong
 * org credentials, …) and we'd rather abort loudly than silently
 * create a duplicate or miss the existing row.
 */
const LIST_SAFETY_CAP = 100;

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  /** Mark a value as a secret so the runtime masks it in logs. */
  mask(value: string): void;
}

/**
 * Discriminated payload for the deploy. The platform contract
 * accepts EITHER `code` (pre-built bundle) OR `files` (managed
 * build) — never both. The action's input schema enforces the same
 * XOR at parse time, so the orchestrator just forwards whichever
 * shape was prepared by `index.ts`.
 */
export type DeployPayload =
  | { kind: 'code'; code: string; sourceMap?: string }
  | { kind: 'files'; files: Record<string, string> };

export interface OrchestratorDeps {
  apiBaseUrl: string;
  apiKey: string;
  /** Pre-loaded payload (caller reads bundle or walks the dir). */
  payload: DeployPayload;
  log: Logger;
  /** Test seam — overrides the api wrapper. */
  api?: typeof api;
}

export interface OrchestratorResult {
  functionId: string;
  deployStatus: string;
  created: boolean;
  secretsUpserted: number;
  redeployed: boolean;
}

export async function deployFunction(
  inputs: Inputs,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const apiDeps = { apiKey: deps.apiKey, apiBaseUrl: deps.apiBaseUrl };
  const A = deps.api ?? api;

  // 1. Optional safety guard: assert the API key belongs to the org
  //    the workflow expects to deploy into. Skipped if not configured.
  if (inputs.expectedOrgId) {
    const me = await A.whoami(apiDeps);
    if (me.org_id !== inputs.expectedOrgId) {
      throw new Error(
        `expected-org-id guard failed: API key belongs to org ${me.org_id}, ` +
        `but workflow asserts ${inputs.expectedOrgId}`,
      );
    }
    deps.log.info(`whoami guard passed (org_id=${me.org_id})`);
  }

  // 2. Look up the function by name. Idempotent across reruns.
  const rows = await A.listFunctions(apiDeps);
  if (rows.length > LIST_SAFETY_CAP) {
    throw new Error(
      `refusing to deploy: /v1/functions returned ${rows.length} rows ` +
      `(> ${LIST_SAFETY_CAP}). Inspect the org or raise the cap.`,
    );
  }
  const existing = rows.find((row) => row.name === inputs.name);
  const created = !existing;

  // 3. Upsert custom secrets BEFORE the (potential) initial deploy
  //    when we already have a function id to attach them to. For
  //    initial-create, secrets get upserted AFTER the POST so we
  //    have an id to write against. The conditional redeploy at the
  //    end stitches the two cases together cleanly.
  const secretKeys = Object.keys(inputs.secrets);
  for (const v of Object.values(inputs.secrets)) deps.log.mask(v);
  let secretsUpserted = 0;

  let row: FunctionRow;
  if (existing) {
    if (secretKeys.length > 0) {
      deps.log.info(`upserting ${secretKeys.length} secret(s) on existing function ${existing.id}`);
      for (const key of secretKeys) {
        await A.upsertSecret(apiDeps, existing.id, key, inputs.secrets[key]!);
        secretsUpserted++;
      }
    }
    deps.log.info(`updating function id=${existing.id} name=${inputs.name} (${deps.payload.kind} mode)`);
    row = await A.updateFunction(apiDeps, existing.id, bodyFromPayload(deps.payload));
  } else {
    deps.log.info(`creating new function name=${inputs.name} (${deps.payload.kind} mode)`);
    row = await A.createFunction(apiDeps, {
      name: inputs.name,
      ...bodyFromPayload(deps.payload),
    });
    if (secretKeys.length > 0) {
      deps.log.info(`upserting ${secretKeys.length} secret(s) on new function ${row.id}`);
      for (const key of secretKeys) {
        await A.upsertSecret(apiDeps, row.id, key, inputs.secrets[key]!);
        secretsUpserted++;
      }
    }
  }

  // 4. Conditional redeploy. Secrets are bound at deploy time, so
  //    after a create-then-upsert sequence (new-function case) the
  //    live bindings still reflect the initial empty set; for the
  //    update case the upserts land BEFORE the PUT but /redeploy
  //    ensures the runtime picks up the freshly written values.
  //    /redeploy re-binds.
  //
  // Load-bearing on the create path: a brand-new function's secrets
  // CAN'T be upserted before the POST (no id yet), so without the
  // redeploy the function goes live with an empty binding set. We
  // throw when the operator opted out of the redeploy on this
  // specific combination — for the update path the secrets land
  // before the PUT so a skipped redeploy is just slower, not broken.
  let redeployed = false;
  if (created && secretsUpserted > 0 && !inputs.redeployOnSecretChange) {
    // Fail loud rather than green-checking a non-functional deploy. The
    // function row exists, the secrets are written, but the runtime is
    // still bound to the empty initial set — any invocation will error
    // out. Surfacing this as an action failure forces the operator to
    // either re-run with redeploy-on-secret-change=true or hit the
    // /redeploy endpoint manually, instead of finding out later that
    // the green CI run shipped a broken function.
    throw new Error(
      `new function ${row.id} was created with ${secretsUpserted} secret(s) upserted, ` +
      `but redeploy-on-secret-change is false. The runtime DOES NOT see these secrets — ` +
      `the initial deploy predated the secret writes. Re-enable redeploy-on-secret-change ` +
      `or trigger a manual POST ${inputs.apiBaseUrl}/functions/${row.id}/redeploy.`,
    );
  }
  if (inputs.redeployOnSecretChange && secretsUpserted > 0) {
    deps.log.info(`redeploying function ${row.id} to bind ${secretsUpserted} new secret(s)`);
    row = await A.redeploy(apiDeps, row.id);
    redeployed = true;
  }

  return {
    functionId: row.id,
    deployStatus: row.deploy_status ?? 'unknown',
    created,
    secretsUpserted,
    redeployed,
  };
}

/**
 * Project a discriminated DeployPayload onto the shape the API
 * wrapper expects. Keeps the API typings honest (each call site
 * declares exactly which fields it sends) and gives the orchestrator
 * a single branch-point for code-vs-files.
 */
function bodyFromPayload(
  p: DeployPayload,
): { code: string; sourceMap?: string } | { files: Record<string, string> } {
  if (p.kind === 'code') {
    return p.sourceMap !== undefined
      ? { code: p.code, sourceMap: p.sourceMap }
      : { code: p.code };
  }
  return { files: p.files };
}

export { ApiError };
