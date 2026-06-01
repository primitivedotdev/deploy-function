/**
 * api.ts wrapper tests. Stubs global fetch to verify request shape
 * (method, headers, body) and the envelope-unwrap behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from '../src/api.js';

const DEPS = { apiBaseUrl: 'https://api.example.com/v1', apiKey: 'prim_test' };

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function err(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api.whoami', () => {
  it('returns the data envelope', async () => {
    fetchMock.mockResolvedValueOnce(ok({ org_id: 'org-1' }));
    const me = await api.whoami(DEPS);
    expect(me).toEqual({ org_id: 'org-1' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/whoami',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer prim_test' },
      }),
    );
  });

  it('retries once on 5xx', async () => {
    fetchMock
      .mockResolvedValueOnce(err(503, { error: { message: 'temp' } }))
      .mockResolvedValueOnce(ok({ org_id: 'org-1' }));
    const me = await api.whoami(DEPS);
    expect(me.org_id).toBe('org-1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws ApiError on 4xx', async () => {
    fetchMock.mockResolvedValueOnce(err(401, { error: { message: 'unauthorized' } }));
    await expect(api.whoami(DEPS)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('api.listFunctions', () => {
  it('returns the array directly from the data envelope', async () => {
    fetchMock.mockResolvedValueOnce(ok([{ id: 'a', name: 'fn-a' }]));
    const rows = await api.listFunctions(DEPS);
    expect(rows).toEqual([{ id: 'a', name: 'fn-a' }]);
  });
});

describe('api.createFunction / updateFunction', () => {
  it('POSTs to /functions with name + code + sourceMap', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'fn-1', name: 'zork', deploy_status: 'deployed' }));
    const row = await api.createFunction(DEPS, { name: 'zork', code: 'X', sourceMap: 'M' });
    expect(row.id).toBe('fn-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/functions');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'zork',
      code: 'X',
      sourceMap: 'M',
    });
  });

  it('does NOT retry POST on 5xx', async () => {
    fetchMock.mockResolvedValueOnce(err(503, { error: { message: 'temp' } }));
    await expect(
      api.createFunction(DEPS, { name: 'zork', code: 'X' }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('PUTs to /functions/{id} with code (no name)', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'fn-1', name: 'zork', deploy_status: 'deployed' }));
    await api.updateFunction(DEPS, 'fn-1', { code: 'X' });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/functions/fn-1');
    expect((init as RequestInit).method).toBe('PUT');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ code: 'X' });
  });

  it('URL-encodes the function id', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'a/b', name: 'x', deploy_status: 'deployed' }));
    await api.updateFunction(DEPS, 'with/slash', { code: '' });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      'https://api.example.com/v1/functions/with%2Fslash',
    );
  });
});

describe('api.upsertSecret + api.redeploy', () => {
  it('POSTs to /functions/{id}/secrets', async () => {
    fetchMock.mockResolvedValueOnce(ok({ key: 'K', created: true }));
    await api.upsertSecret(DEPS, 'fn-1', 'K', 'V');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/functions/fn-1/secrets');
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ key: 'K', value: 'V' });
  });

  it('POSTs to /functions/{id}/redeploy with no body', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'fn-1', name: 'zork', deploy_status: 'deployed' }));
    await api.redeploy(DEPS, 'fn-1');
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.example.com/v1/functions/fn-1/redeploy');
    expect((init as RequestInit).method).toBe('POST');
    expect((init as RequestInit).body).toBeUndefined();
  });
});

describe('api transport errors', () => {
  it('throws ApiError with status=0 on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('econnreset'));
    await expect(api.whoami(DEPS)).rejects.toMatchObject({ status: 0 });
  });

  it('throws ApiError with status=0 + "retry" prefix when retry itself fails', async () => {
    // first attempt: 5xx (triggers retry); second attempt: network throw
    // (e.g. an AbortError because the shared signal would have fired).
    fetchMock
      .mockResolvedValueOnce(err(503, { error: { message: 'temp' } }))
      .mockRejectedValueOnce(new Error('aborted'));
    await expect(api.whoami(DEPS)).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('retry'),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retry uses a fresh AbortSignal (not the first attempt\'s)', async () => {
    let firstSignal: AbortSignal | undefined;
    let retrySignal: AbortSignal | undefined;
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => {
      if (firstSignal === undefined) {
        firstSignal = init.signal as AbortSignal;
        return err(503, { error: { message: 'temp' } });
      }
      retrySignal = init.signal as AbortSignal;
      return ok({ org_id: 'org-1' });
    });
    await api.whoami(DEPS);
    expect(firstSignal).toBeDefined();
    expect(retrySignal).toBeDefined();
    expect(retrySignal).not.toBe(firstSignal);
  });
});
