/**
 * The user directory, read over Process Manager's SCIM API.
 *
 * Champions are assigned by numeric user id — `championId: 1084` — and nothing in the
 * tenant-facing API turns a logon into one. SCIM does, so this exists to build a single
 * logon → id map that the champion planner then resolves every row against locally.
 *
 * Three things make it unlike the rest of `lib/pm`:
 *
 *  - **different host.** SCIM lives on `api.promapp.com`, not on the tenant's own origin,
 *    and takes no tenant path segment;
 *  - **different credential.** A SCIM API key, not the session's bearer token. It is
 *    supplied per request by the operator and is never stored — not in the session
 *    cookie, not on the server, not in the browser's storage;
 *  - **different failure meaning.** A 401 here means "that key is wrong", not "your
 *    session died", so it must never be routed into the sign-out path. Hence ScimError.
 */

/** SCIM's own page size. Sent explicitly so a server-side default cannot surprise us. */
const PAGE_SIZE = 200;

/** Enough for 20,000 users. A directory larger than that is a conversation, not a retry. */
const MAX_PAGES = 100;

export interface DirectoryUser {
  /** The `championId` the assign endpoints want. */
  userId: number;
  /** SCIM `userName` — what the operator types in the spreadsheet. */
  logon: string;
  /** "Given Family", for the preview. Falls back to the logon. */
  displayName: string;
  /** Inactive users can still be assigned, and almost never should be. */
  active: boolean;
}

export class ScimError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = 'ScimError';
    this.status = status;
  }
}

export function isScimError(error: unknown): error is ScimError {
  return error instanceof Error && error.name === 'ScimError';
}

/**
 * Where SCIM lives for a given tenant origin.
 *
 * `demo.promapp.com` → `api.promapp.com`, and `x.promapp.com.au` → `api.promapp.com.au`,
 * by replacing the leading label. Regional deployments differ only in that suffix, so
 * deriving beats hard-coding one host — but SCIM_BASE_URL overrides it for anything this
 * rule does not cover rather than leaving a customer stuck.
 */
export function scimBaseUrl(tenantBaseUrl: string, override?: string | undefined): string {
  if (override) return override.replace(/\/+$/, '');

  const host = new URL(tenantBaseUrl).hostname;
  const labels = host.split('.');
  // A bare `promapp.com` has nothing to replace; anything longer loses its first label.
  const suffix = labels.length > 2 ? labels.slice(1).join('.') : host;
  return `https://api.${suffix}`;
}

interface ScimName {
  givenName?: string | null;
  familyName?: string | null;
  formatted?: string | null;
}

interface ScimUser {
  id?: string | null;
  userName?: string | null;
  name?: ScimName | null;
  active?: boolean | null;
}

interface ScimListResponse {
  Resources?: ScimUser[] | null;
  totalResults?: number | null;
  itemsPerPage?: number | null;
  startIndex?: number | null;
}

function displayNameOf(user: ScimUser, logon: string): string {
  const formatted = user.name?.formatted?.trim();
  if (formatted) return formatted;
  const parts = [user.name?.givenName, user.name?.familyName]
    .map((part) => (part ?? '').trim())
    .filter((part) => part !== '');
  return parts.length > 0 ? parts.join(' ') : logon;
}

/**
 * Every user in the tenant, paginated.
 *
 * Users with no id or no logon are dropped rather than carried as unusable rows: a
 * champion cannot be assigned without an id, and cannot be matched without a logon.
 */
export async function listDirectoryUsers(options: {
  baseUrl: string;
  apiKey: string;
  fetch: typeof fetch;
}): Promise<DirectoryUser[]> {
  const users: DirectoryUser[] = [];
  // Resources seen, not users kept. Dropping an unusable row must not stop the count
  // reaching totalResults, or the walk pages forever over a directory with one in it.
  let seen = 0;
  let startIndex = 1;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${options.baseUrl}/api/scim/users`);
    url.searchParams.set('startIndex', String(startIndex));
    url.searchParams.set('count', String(PAGE_SIZE));

    let response: Response;
    try {
      response = await options.fetch(url.toString(), {
        headers: {
          Accept: 'application/scim+json, application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
      });
    } catch (cause) {
      throw new ScimError(`Could not reach the user directory: ${(cause as Error).message}`);
    }

    if (response.status === 401 || response.status === 403) {
      throw new ScimError(
        'The user directory rejected that SCIM API key. Check it in Process Manager ' +
          'under Admin, and make sure it is for this tenant.',
        response.status,
      );
    }
    if (!response.ok) {
      throw new ScimError(
        `The user directory returned ${response.status}. Champions cannot be resolved ` +
          `without it.`,
        response.status,
      );
    }

    let body: ScimListResponse;
    try {
      body = (await response.json()) as ScimListResponse;
    } catch {
      throw new ScimError('The user directory returned something that was not JSON.');
    }

    const resources = body.Resources ?? [];
    seen += resources.length;

    for (const user of resources) {
      // SCIM ids are strings. `Number(null)` is 0 and `Number('')` is 0, so a missing id
      // would otherwise pass an integer check and be sent as championId 0.
      const userId = typeof user.id === 'string' && user.id.trim() !== '' ? Number(user.id) : NaN;
      const logon = (user.userName ?? '').trim();
      if (!Number.isInteger(userId) || userId <= 0 || logon === '') continue;

      users.push({
        userId,
        logon,
        displayName: displayNameOf(user, logon),
        active: user.active !== false,
      });
    }

    const total = body.totalResults ?? seen;
    // An empty page ends the walk whatever the count says — a totalResults that never
    // agrees with reality would otherwise spin to MAX_PAGES.
    if (resources.length === 0 || seen >= total) break;
    startIndex += resources.length;
  }

  return users;
}

export type DirectoryLookup = DirectoryUser | 'ambiguous' | null;

/**
 * A logon → user map that refuses to guess.
 *
 * Logons are matched case-insensitively, because SCIM keeps whatever case the account
 * was registered with and nobody retypes `Ricco.Ugas@Nintex.com` correctly. Two accounts
 * whose logons differ only by case are therefore indistinguishable from a spreadsheet,
 * and both are marked ambiguous rather than one of them being picked.
 *
 * Email is deliberately *not* matched on. In the demo tenant alone one address is shared
 * by fourteen accounts and another by three, so an email identifies a person but not an
 * account — and it is the account that gets the permission.
 */
export function indexUsersByLogon(users: readonly DirectoryUser[]): Map<string, DirectoryLookup> {
  const byLogon = new Map<string, DirectoryLookup>();

  for (const user of users) {
    const key = user.logon.trim().toLowerCase();
    byLogon.set(key, byLogon.has(key) ? 'ambiguous' : user);
  }

  return byLogon;
}
