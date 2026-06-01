/**
 * Thin wrapper over the public Primitive API surface this action
 * consumes. All requests carry the Bearer API key; all response
 * envelopes are unwrapped at this boundary so the orchestrator only
 * sees domain data, never the platform's transport shape.
 *
 * Retry policy: GET retries once on 5xx (idempotent). POST/PUT do not
 * retry — duplicate writes would be worse than a transient failure;
 * the workflow caller can re-run the job manually.
 */

const FETCH_TIMEOUT_MS = 30_000;

export interface ApiDeps {
  apiKey: string;
  apiBaseUrl: string;
  fetch?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface FunctionRow {
  id: string;
  name: string;
  deploy_status?: string;
}

export interface WhoamiResult {
  org_id: string;
}

interface RequestOpts {
  method: 'GET' | 'POST' | 'PUT';
  path: string;
  body?: unknown;
  /** Internal: GET retries once on 5xx. POST/PUT do not. */
  retryOn5xx?: boolean;
}

async function call<T>(deps: ApiDeps, opts: RequestOpts): Promise<T> {
  const url = `${deps.apiBaseUrl}${opts.path}`;
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.apiKey}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const init: RequestInit = {
    method: opts.method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };

  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    throw new ApiError(
      `network error: ${(err as Error).message}`,
      0,
      undefined,
    );
  }

  if (res.status >= 500 && opts.retryOn5xx) {
    // single retry, capped delay; the engine doesn't need anything more
    // sophisticated for an Action that runs at most a handful of times.
    //
    // Fresh AbortSignal for the retry — re-using `init.signal` would
    // hand the retry whatever timeout budget the first attempt didn't
    // burn, so a slow first attempt (returns 503 just before the 30s
    // deadline) would cause the retry to abort immediately. The
    // try/catch then funnels any retry-side network failure through
    // the same ApiError(status=0) shape the first attempt would emit.
    await new Promise((r) => setTimeout(r, 1_000));
    const retryInit: RequestInit = { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    try {
      res = await fetchImpl(url, retryInit);
    } catch (err) {
      throw new ApiError(
        `network error (retry): ${(err as Error).message}`,
        0,
        undefined,
      );
    }
  }

  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text === '' ? undefined : JSON.parse(text);
  } catch {
    parsed = text;
  }

  if (!res.ok) {
    const envelope = parsed as { error?: { code?: string; message?: string } } | undefined;
    const detail =
      envelope?.error?.message ?? (typeof parsed === 'string' ? parsed : 'unknown');
    throw new ApiError(`${res.status} ${detail}`, res.status, parsed);
  }

  const envelope = parsed as { success?: boolean; data?: T } | undefined;
  // The control-plane API wraps successful responses in {success: true,
  // data: …}. Older or worker-direct endpoints sometimes return data
  // raw, so we accept either.
  if (envelope && 'data' in envelope) return envelope.data as T;
  return parsed as T;
}

export const api = {
  whoami(deps: ApiDeps): Promise<WhoamiResult> {
    return call<WhoamiResult>(deps, { method: 'GET', path: '/whoami', retryOn5xx: true });
  },

  listFunctions(deps: ApiDeps): Promise<FunctionRow[]> {
    return call<FunctionRow[]>(deps, { method: 'GET', path: '/functions', retryOn5xx: true });
  },

  createFunction(
    deps: ApiDeps,
    // The platform accepts EITHER `code` (pre-built bundle) OR
    // `files` (managed build) — never both. The Action's input
    // schema enforces the same XOR at parse time, so the orchestrator
    // can safely build whichever shape the user requested.
    body:
      | { name: string; code: string; sourceMap?: string }
      | { name: string; files: Record<string, string> },
  ): Promise<FunctionRow> {
    return call<FunctionRow>(deps, {
      method: 'POST',
      path: '/functions',
      body,
    });
  },

  updateFunction(
    deps: ApiDeps,
    id: string,
    body:
      | { code: string; sourceMap?: string }
      | { files: Record<string, string> },
  ): Promise<FunctionRow> {
    return call<FunctionRow>(deps, {
      method: 'PUT',
      path: `/functions/${encodeURIComponent(id)}`,
      body,
    });
  },

  upsertSecret(
    deps: ApiDeps,
    functionId: string,
    key: string,
    value: string,
  ): Promise<unknown> {
    return call<unknown>(deps, {
      method: 'POST',
      path: `/functions/${encodeURIComponent(functionId)}/secrets`,
      body: { key, value },
    });
  },

  redeploy(deps: ApiDeps, functionId: string): Promise<FunctionRow> {
    return call<FunctionRow>(deps, {
      method: 'POST',
      path: `/functions/${encodeURIComponent(functionId)}/redeploy`,
    });
  },
};
