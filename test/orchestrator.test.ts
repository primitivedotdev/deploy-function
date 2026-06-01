/**
 * Orchestrator unit tests. Injects a fake `api` so we can exercise
 * every branch (create vs update, secrets present vs absent, redeploy
 * trigger, expected-org-id pass/fail, list-cap abort) without a real
 * fetch.
 */

import { describe, expect, it, vi } from 'vitest';
import { ApiError, type FunctionRow } from '../src/api.js';
import { InputsSchema, type Inputs } from '../src/inputs.js';
import { deployFunction, type Logger } from '../src/orchestrator.js';

const ORG_ID = '5ed84344-6a3a-498d-9656-075401c9634d';

function makeInputs(overrides: Partial<Inputs> & { _mode?: 'code' | 'files' } = {}): Inputs {
  // Default to code-mode for backwards-compatible test calls; mode is
  // selected via the `_mode` test-only field (stripped before parse).
  const mode = overrides._mode ?? 'code';
  const { _mode, ...rest } = overrides;
  void _mode;
  return InputsSchema.parse({
    apiKey: 'prim_test',
    apiBaseUrl: 'https://api.example.com/v1',
    name: 'zork',
    ...(mode === 'code' ? { codePath: 'unused.js' } : { filesPath: '/unused' }),
    secrets: {},
    redeployOnSecretChange: true,
    ignore: [],
    ...rest,
  });
}

function makeLogger(): Logger & { masked: string[]; lines: string[] } {
  const masked: string[] = [];
  const lines: string[] = [];
  return {
    info: (msg) => lines.push(`info: ${msg}`),
    warn: (msg) => lines.push(`warn: ${msg}`),
    mask: (v) => masked.push(v),
    masked,
    lines,
  };
}

// Fakes mirror the real `api` signatures from src/api.ts: every
// method takes `deps` as the first arg (the orchestrator passes its
// pre-built apiDeps through). The overrides expose only the
// per-call args so tests don't have to thread deps everywhere.
//
// Body types are intentionally loose (Record<string, unknown>) so the
// same fake handles both `code`-mode and `files`-mode requests
// without bifurcating the test helpers.
type CreateBody = Record<string, unknown> & { name: string };
type UpdateBody = Record<string, unknown>;

function makeApi(overrides: Partial<{
  whoami: () => Promise<{ org_id: string }>;
  listFunctions: () => Promise<FunctionRow[]>;
  createFunction: (body: CreateBody) => Promise<FunctionRow>;
  updateFunction: (id: string, body: UpdateBody) => Promise<FunctionRow>;
  upsertSecret: (id: string, key: string, value: string) => Promise<unknown>;
  redeploy: (id: string) => Promise<FunctionRow>;
}> = {}) {
  const whoamiImpl = overrides.whoami ?? (async () => ({ org_id: ORG_ID }));
  const listImpl = overrides.listFunctions ?? (async () => []);
  const createImpl =
    overrides.createFunction ??
    (async ({ name }: CreateBody) => ({ id: 'fn-new', name, deploy_status: 'deployed' as const }));
  const updateImpl =
    overrides.updateFunction ??
    (async (id: string) => ({ id, name: 'zork', deploy_status: 'deployed' as const }));
  const upsertImpl = overrides.upsertSecret ?? (async () => ({}));
  const redeployImpl =
    overrides.redeploy ??
    (async (id: string) => ({ id, name: 'zork', deploy_status: 'deployed' as const }));

  return {
    whoami: vi.fn(async (_deps: unknown) => whoamiImpl()),
    listFunctions: vi.fn(async (_deps: unknown) => listImpl()),
    createFunction: vi.fn(async (_deps: unknown, body: CreateBody) => createImpl(body)),
    updateFunction: vi.fn(async (_deps: unknown, id: string, body: UpdateBody) => updateImpl(id, body)),
    upsertSecret: vi.fn(async (_deps: unknown, id: string, key: string, value: string) => upsertImpl(id, key, value)),
    redeploy: vi.fn(async (_deps: unknown, id: string) => redeployImpl(id)),
  };
}

describe('deployFunction — first deploy (function does not exist)', () => {
  it('POSTs a new function and reports created=true', async () => {
    const inputs = makeInputs();
    const log = makeLogger();
    const A = makeApi();
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(A.createFunction).toHaveBeenCalledOnce();
    expect(A.updateFunction).not.toHaveBeenCalled();
    expect(result.created).toBe(true);
    expect(result.functionId).toBe('fn-new');
    expect(result.deployStatus).toBe('deployed');
    expect(result.redeployed).toBe(false);
  });

  it('upserts secrets AFTER create when secrets are provided', async () => {
    const inputs = makeInputs({ secrets: { ZORK_ALLOWED_DOMAIN: 'play.primitive.dev' } });
    const log = makeLogger();
    const order: string[] = [];
    const A = makeApi({
      createFunction: async () => {
        order.push('create');
        return { id: 'fn-new', name: 'zork', deploy_status: 'deployed' };
      },
      upsertSecret: async () => {
        order.push('upsert');
        return {};
      },
      redeploy: async (id: string) => {
        order.push('redeploy');
        return { id, name: 'zork', deploy_status: 'deployed' };
      },
    });
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(order).toEqual(['create', 'upsert', 'redeploy']);
    expect(result.secretsUpserted).toBe(1);
    expect(result.redeployed).toBe(true);
    // Secret value should have been masked.
    expect(log.masked).toContain('play.primitive.dev');
  });
});

describe('deployFunction — update (function exists)', () => {
  it('PUTs the existing function and reports created=false', async () => {
    const inputs = makeInputs();
    const log = makeLogger();
    const A = makeApi({
      listFunctions: async () => [
        { id: 'fn-existing', name: 'zork', deploy_status: 'deployed' },
      ],
    });
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(A.updateFunction).toHaveBeenCalledOnce();
    expect(A.createFunction).not.toHaveBeenCalled();
    expect(result.created).toBe(false);
    expect(result.functionId).toBe('fn-existing');
  });

  it('upserts secrets BEFORE the update when secrets are provided', async () => {
    const inputs = makeInputs({
      secrets: { ZORK_ALLOWED_DOMAIN: 'play.primitive.dev', OTHER: 'x' },
    });
    const log = makeLogger();
    const order: string[] = [];
    const A = makeApi({
      listFunctions: async () => [{ id: 'fn-existing', name: 'zork' }],
      upsertSecret: async () => {
        order.push('upsert');
        return {};
      },
      updateFunction: async (id: string) => {
        order.push('update');
        return { id, name: 'zork', deploy_status: 'deployed' };
      },
      redeploy: async (id: string) => {
        order.push('redeploy');
        return { id, name: 'zork', deploy_status: 'deployed' };
      },
    });
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(order).toEqual(['upsert', 'upsert', 'update', 'redeploy']);
    expect(result.secretsUpserted).toBe(2);
    expect(result.redeployed).toBe(true);
  });

  it('does NOT redeploy when redeployOnSecretChange is false even with secrets upserted', async () => {
    const inputs = makeInputs({
      redeployOnSecretChange: false,
      secrets: { K: 'v' },
    });
    const log = makeLogger();
    const A = makeApi({
      listFunctions: async () => [{ id: 'fn-existing', name: 'zork' }],
    });
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(A.redeploy).not.toHaveBeenCalled();
    expect(result.redeployed).toBe(false);
    expect(result.secretsUpserted).toBe(1);
    // Update path: secrets are upserted BEFORE the PUT, so skipping
    // the redeploy is a perf nit — no warn line.
    expect(log.lines.find((l) => l.startsWith('warn:'))).toBeUndefined();
  });

  it('does NOT redeploy when no secrets are upserted (even if flag is true)', async () => {
    const inputs = makeInputs();
    const log = makeLogger();
    const A = makeApi({
      listFunctions: async () => [{ id: 'fn-existing', name: 'zork' }],
    });
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(A.redeploy).not.toHaveBeenCalled();
    expect(result.redeployed).toBe(false);
  });
});

describe('deployFunction — create + secrets + no-redeploy footgun', () => {
  it('throws when a brand-new function is created with secrets but redeploy is disabled', async () => {
    // The create path forces POST-before-upsert (no id exists yet), so the
    // runtime goes live with an empty secrets binding unless /redeploy fires.
    // Throwing rather than warning makes a non-functional deploy visible to
    // the CI operator instead of green-checking a broken function.
    const inputs = makeInputs({
      redeployOnSecretChange: false,
      secrets: { K: 'v' },
    });
    const log = makeLogger();
    const A = makeApi();
    await expect(
      deployFunction(inputs, {
        apiKey: 'prim_test',
        apiBaseUrl: 'https://api.example.com/v1',
        payload: { kind: 'code', code: 'export default {}' },
        log,
        api: A as never,
      }),
    ).rejects.toThrow(/runtime DOES NOT see these secrets/);
    // The function row and secrets were written before the throw —
    // recovery is "re-run with redeploy=true" or hit /redeploy manually,
    // not "the create never happened."
    expect(A.createFunction).toHaveBeenCalledOnce();
    expect(A.upsertSecret).toHaveBeenCalledOnce();
    expect(A.redeploy).not.toHaveBeenCalled();
  });

  it('does NOT throw for the create+secrets+redeploy=true happy path', async () => {
    const inputs = makeInputs({ secrets: { K: 'v' } });
    const log = makeLogger();
    const A = makeApi();
    await expect(
      deployFunction(inputs, {
        apiKey: 'prim_test',
        apiBaseUrl: 'https://api.example.com/v1',
        payload: { kind: 'code', code: 'export default {}' },
        log,
        api: A as never,
      }),
    ).resolves.toBeDefined();
    expect(log.lines.find((l) => l.startsWith('warn:'))).toBeUndefined();
  });

  it('does NOT throw on create+no-secrets+redeploy=false (nothing to bind)', async () => {
    const inputs = makeInputs({ redeployOnSecretChange: false });
    const log = makeLogger();
    const A = makeApi();
    await expect(
      deployFunction(inputs, {
        apiKey: 'prim_test',
        apiBaseUrl: 'https://api.example.com/v1',
        payload: { kind: 'code', code: 'export default {}' },
        log,
        api: A as never,
      }),
    ).resolves.toBeDefined();
    expect(log.lines.find((l) => l.startsWith('warn:'))).toBeUndefined();
  });
});

describe('deployFunction — expected-org-id guard', () => {
  it('passes when whoami matches', async () => {
    const inputs = makeInputs({ expectedOrgId: ORG_ID });
    const log = makeLogger();
    const A = makeApi();
    await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(A.whoami).toHaveBeenCalledOnce();
  });

  it('aborts when whoami org differs', async () => {
    const inputs = makeInputs({ expectedOrgId: ORG_ID });
    const log = makeLogger();
    const A = makeApi({
      whoami: async () => ({ org_id: '00000000-0000-0000-0000-000000000001' }),
    });
    await expect(
      deployFunction(inputs, {
        apiKey: 'prim_test',
        apiBaseUrl: 'https://api.example.com/v1',
        payload: { kind: 'code', code: 'export default {}' },
        log,
        api: A as never,
      }),
    ).rejects.toThrow(/expected-org-id guard failed/);
    expect(A.listFunctions).not.toHaveBeenCalled();
  });

  it('skips whoami entirely when expectedOrgId is unset', async () => {
    const inputs = makeInputs();
    const log = makeLogger();
    const A = makeApi();
    await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'code', code: 'export default {}' },
      log,
      api: A as never,
    });
    expect(A.whoami).not.toHaveBeenCalled();
  });
});

describe('deployFunction — list safety cap', () => {
  it('aborts loudly when the list exceeds the cap', async () => {
    const inputs = makeInputs();
    const log = makeLogger();
    const bigList: FunctionRow[] = Array.from({ length: 101 }, (_, i) => ({
      id: `id-${i}`,
      name: `fn-${i}`,
    }));
    const A = makeApi({ listFunctions: async () => bigList });
    await expect(
      deployFunction(inputs, {
        apiKey: 'prim_test',
        apiBaseUrl: 'https://api.example.com/v1',
        payload: { kind: 'code', code: 'export default {}' },
        log,
        api: A as never,
      }),
    ).rejects.toThrow(/refusing to deploy/);
  });
});

describe('deployFunction — files mode (managed build)', () => {
  it('POSTs `files` shape on create', async () => {
    const inputs = makeInputs({ _mode: 'files' });
    const log = makeLogger();
    const A = makeApi();
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'files', files: { 'package.json': '{}', 'src/x.ts': 'x' } },
      log,
      api: A as never,
    });
    expect(result.created).toBe(true);
    // Inspect the actual POST body the orchestrator built.
    const createCall = A.createFunction.mock.calls[0]!;
    const body = createCall[1] as Record<string, unknown>;
    expect(body).toEqual({
      name: 'zork',
      files: { 'package.json': '{}', 'src/x.ts': 'x' },
    });
    expect(body).not.toHaveProperty('code');
    expect(body).not.toHaveProperty('sourceMap');
  });

  it('PUTs `files` shape on update', async () => {
    const inputs = makeInputs({ _mode: 'files' });
    const log = makeLogger();
    const A = makeApi({
      listFunctions: async () => [{ id: 'fn-existing', name: 'zork' }],
    });
    await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'files', files: { 'package.json': '{}', 'src/x.ts': 'x' } },
      log,
      api: A as never,
    });
    const updateCall = A.updateFunction.mock.calls[0]!;
    const body = updateCall[2] as Record<string, unknown>;
    expect(body).toEqual({
      files: { 'package.json': '{}', 'src/x.ts': 'x' },
    });
    expect(body).not.toHaveProperty('code');
  });

  it('files-mode + secrets follows the same upsert + redeploy contract as code-mode', async () => {
    const inputs = makeInputs({ _mode: 'files', secrets: { K: 'v' } });
    const log = makeLogger();
    const order: string[] = [];
    const A = makeApi({
      createFunction: async () => {
        order.push('create');
        return { id: 'fn-new', name: 'zork', deploy_status: 'deployed' };
      },
      upsertSecret: async () => {
        order.push('upsert');
        return {};
      },
      redeploy: async (id: string) => {
        order.push('redeploy');
        return { id, name: 'zork', deploy_status: 'deployed' };
      },
    });
    const result = await deployFunction(inputs, {
      apiKey: 'prim_test',
      apiBaseUrl: 'https://api.example.com/v1',
      payload: { kind: 'files', files: { 'package.json': '{}' } },
      log,
      api: A as never,
    });
    expect(order).toEqual(['create', 'upsert', 'redeploy']);
    expect(result.redeployed).toBe(true);
  });
});

describe('deployFunction — propagates ApiError unchanged', () => {
  it('lets a 4xx from updateFunction bubble', async () => {
    const inputs = makeInputs();
    const log = makeLogger();
    const A = makeApi({
      listFunctions: async () => [{ id: 'fn-existing', name: 'zork' }],
      updateFunction: async () => {
        throw new ApiError('400 validation_error: bad bundle', 400, undefined);
      },
    });
    await expect(
      deployFunction(inputs, {
        apiKey: 'prim_test',
        apiBaseUrl: 'https://api.example.com/v1',
        payload: { kind: 'code', code: 'export default {}' },
        log,
        api: A as never,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
