/**
 * Request plumbing for the Process Manager API.
 *
 * Deliberately has no Next.js or browser dependencies: the same client runs in a
 * route handler, in tests, and (via the proxy) on behalf of the browser. The fetch
 * implementation is injected so tests never touch the network.
 */

export interface PmContext {
  /** Origin only, no trailing slash. e.g. https://demo.promapp.com */
  baseUrl: string;
  /** Tenant path segment. e.g. 93555a16ceb24f139a6e8a40618d3f8b */
  tenant: string;
  /** OAuth bearer token from /oauth2/token. */
  token: string;
  /**
   * ASP.NET antiforgery token.
   *
   * Confirmed **not required** for bearer-authenticated calls, reads or writes — the
   * token in the HAR captures is a browser-session artefact, and Nintex's own bulk
   * PowerShell script writes to production tenants without one. Retained only as an
   * escape hatch if some endpoint ever turns out to differ; nothing sets it today.
   */
  antiforgeryToken?: string | undefined;
  fetch: typeof fetch;
  /** Injected so tests do not actually wait. */
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

/**
 * Whether a failed attempt may be retried.
 *
 * - `read`   nothing was changed, so anything transient is safe to repeat.
 * - `write`  the request may have been applied before the failure. Only retried when
 *            the server tells us it definitely was not (429/408), because repeating
 *            a CreateGroup that actually succeeded leaves an orphan behind.
 */
export type RetryPolicy = 'read' | 'write';

export interface PmRequestOptions {
  /** Path below the tenant segment, starting with a slash. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Serialised as JSON unless `form` is set. */
  body?: unknown;
  /** Send as application/x-www-form-urlencoded instead of JSON. */
  form?: Record<string, string>;
  query?: Record<string, string | number | undefined>;
  retry?: RetryPolicy;
  /** Overrides the default attempt count. */
  attempts?: number;
  /**
   * How to read a successful body. `text` is for endpoints that return CSV rather
   * than JSON, such as the process list report.
   */
  parse?: 'json' | 'text';
}

export interface PmError extends Error {
  name: 'PmError';
  status: number | null;
  url: string;
  bodyText: string;
}

export function isPmError(e: unknown): e is PmError {
  return e instanceof Error && e.name === 'PmError';
}

function pmError(message: string, status: number | null, url: string, bodyText: string): PmError {
  const err = new Error(message) as PmError;
  err.name = 'PmError';
  err.status = status;
  err.url = url;
  err.bodyText = bodyText;
  return err;
}

/**
 * Defaults taken from the tenant's own advertised resilience config
 * (`ResilienceApiCallAttemptsCount`, `ResilienceApiCallDelaySec`) rather than invented.
 */
export const DEFAULT_ATTEMPTS = 5;
export const BASE_DELAY_MS = 3_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function buildUrl(ctx: PmContext, path: string, query?: PmRequestOptions['query']): string {
  const url = new URL(`${ctx.baseUrl}/${ctx.tenant}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** Retry-After is either seconds or an HTTP date. */
function retryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

function shouldRetry(status: number | null, policy: RetryPolicy): boolean {
  // A transport failure with no status: we cannot know whether the server applied it.
  if (status === null) return policy === 'read';
  if (status === 429 || status === 408) return true;
  if (status >= 500) return policy === 'read';
  return false;
}

export async function pmRequest<T>(ctx: PmContext, options: PmRequestOptions): Promise<T> {
  const {
    path,
    method = 'GET',
    body,
    form,
    query,
    retry = 'read',
    attempts = DEFAULT_ATTEMPTS,
    parse = 'json',
  } = options;

  const url = buildUrl(ctx, path, query);
  const sleep = ctx.sleep ?? defaultSleep;

  const headers: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    Authorization: `Bearer ${ctx.token}`,
    // Process Manager's MVC endpoints branch on this; without it some return HTML.
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (ctx.antiforgeryToken) headers['__RequestVerificationToken'] = ctx.antiforgeryToken;

  let payload: string | undefined;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  let lastError: PmError | null = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: Response;
    try {
      response = await ctx.fetch(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (cause) {
      lastError = pmError(
        `Network error calling ${method} ${path}: ${(cause as Error).message}`,
        null,
        url,
        '',
      );
      if (attempt < attempts && shouldRetry(null, retry)) {
        await sleep(backoffMs(attempt, null));
        continue;
      }
      throw lastError;
    }

    if (response.ok) return parseBody<T>(response, parse);

    const text = await safeText(response);
    lastError = pmError(
      `Process Manager returned ${response.status} for ${method} ${path}`,
      response.status,
      url,
      text,
    );

    if (attempt < attempts && shouldRetry(response.status, retry)) {
      await sleep(backoffMs(attempt, retryAfterMs(response.headers.get('retry-after'))));
      continue;
    }
    throw lastError;
  }

  throw lastError ?? pmError(`Request failed: ${method} ${path}`, null, url, '');
}

/** Exponential backoff, unless the server named its own delay. */
export function backoffMs(attempt: number, retryAfter: number | null): number {
  if (retryAfter !== null) return retryAfter;
  return BASE_DELAY_MS * 2 ** (attempt - 1);
}

async function parseBody<T>(response: Response, parse: 'json' | 'text'): Promise<T> {
  // 204 is the documented success for the process PUT.
  if (response.status === 204) return undefined as T;
  const text = await safeText(response);
  if (parse === 'text') return text as T;
  if (text.trim() === '') return undefined as T;
  return JSON.parse(text) as T;
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}
