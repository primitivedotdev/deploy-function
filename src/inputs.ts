/**
 * Input parsing for the Deploy Primitive Function GitHub Action.
 *
 * `@actions/core.getInput` always returns a string; this module is
 * the single place we convert action-runtime strings into a
 * validated, typed config (zod). Conversion failures throw with a
 * readable message so the action fails fast at top-of-run rather
 * than mid-deploy.
 */

import { z } from 'zod';

/**
 * Function-name shape mirrors the platform's contract
 * (`CreateFunctionBodySchema` in `packages/core-api-contract`). Keeping
 * it client-side too gives the action a fast-fail without a round-trip.
 */
const functionNameRegex = /^[a-z0-9_-]{1,64}$/;

export const InputsSchema = z
  .object({
    apiKey: z.string().min(1, 'api-key is required'),
    apiBaseUrl: z
      .string()
      .url()
      .transform((s) => s.replace(/\/+$/, '')),
    name: z
      .string()
      .regex(
        functionNameRegex,
        'name must be 1-64 chars of [a-z0-9_-]',
      ),
    /**
     * Pre-built bundle path (`code` mode). Mutually exclusive with
     * `filesPath`; the action refuses to start if both are set or
     * both empty. Resolved + read by `index.ts`; the bytes go up as
     * the `code` field on POST/PUT /v1/functions.
     */
    codePath: z.string().optional(),
    sourceMapPath: z.string().optional(),
    /**
     * Source-directory path (`files` mode = managed build). The
     * action walks the directory, applies the default + caller
     * ignore patterns, and POSTs/PUTs the resulting
     * `{relativePath: contents}` map as the `files` field.
     * Requires `functions_managed_build` entitlement on the org;
     * Mutually exclusive with `codePath`.
     */
    filesPath: z.string().optional(),
    /**
     * Additional ignore patterns layered on top of `DEFAULT_IGNORE`
     * (see `src/files.ts`). Basename matches; exact name OR simple
     * glob (`*.log`). One pattern per line, `#` comments allowed.
     */
    ignore: z.array(z.string()).default([]),
    /**
     * Custom function_secrets. Strict map<string,string>; values
     * become `function_secrets` rows via POST /v1/functions/{id}/secrets.
     * Empty object means "leave existing secrets untouched".
     */
    secrets: z.record(z.string(), z.string()).default({}),
    redeployOnSecretChange: z.boolean().default(true),
    /** Optional cross-org safety guard. */
    expectedOrgId: z.string().uuid().optional(),
  })
  .strict()
  .refine(
    (v) => (v.codePath != null) !== (v.filesPath != null),
    'exactly one of code-path or files-path is required (and not both)',
  )
  .refine(
    (v) => v.sourceMapPath == null || v.codePath != null,
    'source-map-path is only valid with code-path',
  );

export type Inputs = z.infer<typeof InputsSchema>;

/**
 * Parse the `secrets` action input.
 *
 * The input is a JSON string in action.yml; we accept either an empty
 * string or `{}` as "no secrets" so workflows can omit the input
 * entirely (the default in action.yml is `'{}'`). All other parse
 * errors surface as a config-time failure.
 */
export function parseSecretsJson(raw: string): Record<string, string> {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === '{}') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(
      `secrets must be a JSON object string; got: ${(err as Error).message}`,
    );
  }
  const shape = z.record(z.string(), z.string()).safeParse(parsed);
  if (!shape.success) {
    throw new Error(
      `secrets must be a JSON object of string->string; got: ${shape.error.issues[0]?.message ?? 'invalid shape'}`,
    );
  }
  return shape.data;
}

/**
 * Parse a boolean from an action input string. action.yml booleans
 * arrive as raw strings; we accept the standard `true`/`false`
 * spellings plus `1`/`0` for friendliness. Anything else throws so
 * a typo in a workflow doesn't silently flip a flag.
 */
export function parseBool(raw: string, fieldName: string): boolean {
  const norm = raw.trim().toLowerCase();
  if (norm === '' || norm === 'true' || norm === '1') return true;
  if (norm === 'false' || norm === '0') return false;
  throw new Error(`${fieldName} must be 'true' or 'false' (got: ${raw})`);
}
