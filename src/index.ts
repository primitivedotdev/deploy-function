/**
 * Deploy Primitive Function — GitHub Action entrypoint.
 *
 * Thin caller over `orchestrator.deployFunction`:
 *   - parses + validates @actions/core inputs (via `inputs.ts`)
 *   - masks the API key + every custom-secret value
 *   - prepares the deploy payload — reads a pre-built bundle for
 *     `code-path` mode, or walks the source tree for `files-path`
 *     (managed build) mode
 *   - wires `@actions/core` logger seams into the orchestrator
 *   - emits action outputs on success
 *
 * Keeping this file deliberately small means unit tests can exercise
 * `orchestrator.deployFunction` against a fake api/logger and never
 * need the real `@actions/core` runtime.
 */

import * as core from '@actions/core';
import { readFileSync } from 'node:fs';

import { walkSourceTree, parseIgnoreInput } from './files.js';
import { InputsSchema, parseBool, parseSecretsJson } from './inputs.js';
import { ApiError, deployFunction, type DeployPayload } from './orchestrator.js';

async function main(): Promise<void> {
  const apiKey = core.getInput('api-key', { required: true });
  // Mask before doing anything else so an early throw can't leak it
  // via a stack trace that includes the value.
  core.setSecret(apiKey);

  const inputs = InputsSchema.parse({
    apiKey,
    apiBaseUrl: core.getInput('api-base-url') || 'https://api.primitive.dev/v1',
    name: core.getInput('name', { required: true }),
    codePath: core.getInput('code-path') || undefined,
    sourceMapPath: core.getInput('source-map-path') || undefined,
    filesPath: core.getInput('files-path') || undefined,
    ignore: parseIgnoreInput(core.getInput('ignore') || undefined),
    secrets: parseSecretsJson(core.getInput('secrets') || '{}'),
    redeployOnSecretChange: parseBool(
      core.getInput('redeploy-on-secret-change') || 'true',
      'redeploy-on-secret-change',
    ),
    expectedOrgId: core.getInput('expected-org-id') || undefined,
  });

  const payload = buildPayload(inputs);

  const result = await deployFunction(inputs, {
    apiKey,
    apiBaseUrl: inputs.apiBaseUrl,
    payload,
    log: {
      info: (msg) => core.info(msg),
      warn: (msg) => core.warning(msg),
      mask: (value) => core.setSecret(value),
    },
  });

  core.setOutput('function-id', result.functionId);
  core.setOutput('deploy-status', result.deployStatus);
  core.setOutput('created', String(result.created));

  core.info(
    `deploy ok: id=${result.functionId} status=${result.deployStatus} ` +
    `created=${result.created} secretsUpserted=${result.secretsUpserted} ` +
    `redeployed=${result.redeployed}`,
  );
}

/**
 * Prepare the deploy payload from validated inputs.
 *
 * `inputs.ts` already enforced XOR between codePath and filesPath at
 * parse time, so exactly one of the two is set here. Reading the
 * payload off-disk at this layer (not inside the orchestrator) keeps
 * the orchestrator pure-function-friendly for tests.
 */
function buildPayload(inputs: ReturnType<typeof InputsSchema.parse>): DeployPayload {
  if (inputs.codePath !== undefined) {
    const code = readFileSync(inputs.codePath, 'utf8');
    const sourceMap = inputs.sourceMapPath
      ? readFileSync(inputs.sourceMapPath, 'utf8')
      : undefined;
    core.info(`deploy: code mode, bundle=${code.length} chars, sourceMap=${sourceMap?.length ?? 0} chars`);
    return sourceMap !== undefined ? { kind: 'code', code, sourceMap } : { kind: 'code', code };
  }
  // filesPath path — `inputs.ts` guarantees one of the two is set.
  const walked = walkSourceTree(inputs.filesPath!, { ignore: inputs.ignore });
  core.info(
    `deploy: files mode, ${walked.fileCount} file(s), ` +
    `${walked.totalBytes} bytes total from ${inputs.filesPath}`,
  );
  return { kind: 'files', files: walked.files };
}

main().catch((err: unknown) => {
  if (err instanceof ApiError) {
    core.setFailed(`API error (${err.status}): ${err.message}`);
    return;
  }
  if (err instanceof Error) {
    core.setFailed(err.message);
    return;
  }
  core.setFailed(String(err));
});
