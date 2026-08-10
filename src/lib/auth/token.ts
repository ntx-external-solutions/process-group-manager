/**
 * Credential exchange.
 *
 * Process Manager exposes the OAuth Resource Owner Password Credentials grant. It is
 * the only flow available to us, and it has two consequences worth stating plainly:
 *
 *  - the server briefly handles the user's plaintext password. It is used for this
 *    one call and never stored, logged, or placed in a session;
 *  - it cannot work for SSO/federated users, who have no local password. The product
 *    decision (DESIGN.md) is that SSO tenants are out of scope for v1.
 */

export interface TokenRequest {
  baseUrl: string;
  tenant: string;
  username: string;
  password: string;
  fetch: typeof fetch;
}

export interface TokenGrant {
  token: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * Fallback lifetime when the server does not return `expires_in`.
 *
 * The response body is the one part of this flow we have not observed — the Postman
 * collection captured the request only. Eight hours is a working day; if the real
 * token is shorter the user gets a 401 mid-run, which the UI reports and recovers
 * from by asking them to sign in again.
 */
const DEFAULT_LIFETIME_MS = 8 * 60 * 60 * 1000;

/** Matches the `duration` parameter the collection sends. */
const REQUESTED_DURATION = '60000';

export interface TokenFailure {
  ok: false;
  status: number | null;
  /** Safe to show a user. Never contains the password. */
  message: string;
}

export type TokenResult = ({ ok: true } & TokenGrant) | TokenFailure;

export async function requestToken(request: TokenRequest): Promise<TokenResult> {
  const { baseUrl, tenant, username, password, fetch: fetchImpl } = request;

  const body = new URLSearchParams({
    grant_type: 'password',
    username,
    password,
    duration: REQUESTED_DURATION,
  });

  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/${tenant}/oauth2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch {
    // Deliberately not echoing the underlying error: it can contain the request,
    // and the request contains the password.
    return {
      ok: false,
      status: null,
      message: 'Could not reach Process Manager. Check the site address and try again.',
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      message:
        response.status === 400 || response.status === 401
          ? 'Sign-in failed. Check the username and password.'
          : `Process Manager rejected the sign-in (HTTP ${response.status}).`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      status: response.status,
      message: 'Process Manager returned an unreadable sign-in response.',
    };
  }

  const token = readToken(payload);
  if (!token) {
    return {
      ok: false,
      status: response.status,
      message: 'Process Manager did not return an access token.',
    };
  }

  return { ok: true, token, expiresAt: Date.now() + readLifetimeMs(payload) };
}

function readToken(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  // Accept both the OAuth-standard and the PascalCase variant, since the response
  // shape is unconfirmed and the rest of this API is inconsistent about casing.
  const value = record['access_token'] ?? record['accessToken'] ?? record['AccessToken'];
  return typeof value === 'string' && value !== '' ? value : null;
}

function readLifetimeMs(payload: unknown): number {
  if (typeof payload !== 'object' || payload === null) return DEFAULT_LIFETIME_MS;
  const record = payload as Record<string, unknown>;
  const seconds = record['expires_in'] ?? record['expiresIn'];
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return DEFAULT_LIFETIME_MS;
}

/**
 * Normalise a user-entered site address.
 *
 * Operators paste whatever is in their address bar, which frequently includes the
 * tenant path, a trailing slash, or no scheme at all.
 */
export function parseSiteAddress(input: string): { baseUrl: string; tenant: string } | null {
  const trimmed = input.trim();
  if (trimmed === '') return null;

  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const segments = url.pathname.split('/').filter((s) => s !== '');
  const tenant = segments[0];
  if (!tenant) return null;

  return { baseUrl: url.origin, tenant };
}
