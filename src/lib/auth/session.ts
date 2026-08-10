/**
 * Session sealing.
 *
 * The Process Manager bearer token is held in an encrypted cookie rather than any
 * server-side store — the deployment is required to keep no customer data (PLAN.md
 * §2). The cookie is set httpOnly, so page scripts cannot read it either.
 *
 * AES-256-GCM via Web Crypto, which is present in both the Node and Edge runtimes.
 * GCM is authenticated, so tampering fails to decrypt rather than yielding altered
 * plaintext.
 *
 * The password is never part of a session. It is used for one token exchange and
 * discarded.
 */

export interface Session {
  /** Origin only, no trailing slash. */
  baseUrl: string;
  tenant: string;
  /** Process Manager bearer token. */
  token: string;
  /** Epoch milliseconds. Checked on every unseal. */
  expiresAt: number;
  /** For display in the UI. Not a credential. */
  username: string;
}

const IV_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derive a fixed-length key from the configured secret.
 *
 * SHA-256 rather than a raw slice, so a short or low-entropy secret still produces a
 * well-formed 256-bit key instead of failing or silently truncating.
 */
async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

export async function seal(session: Session, secret: string): Promise<string> {
  requireSecret(secret);
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify(session));

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );

  const packed = new Uint8Array(iv.length + ciphertext.length);
  packed.set(iv, 0);
  packed.set(ciphertext, iv.length);
  return toBase64Url(packed);
}

/**
 * Returns null for anything that is not a valid, unexpired session — tampered,
 * truncated, encrypted with a different secret, or simply stale. Callers treat null
 * as "not signed in"; there is deliberately no way to distinguish the causes from
 * outside, and no error is thrown that could leak which check failed.
 */
export async function unseal(
  value: string | undefined | null,
  secret: string,
  now: number = Date.now(),
): Promise<Session | null> {
  if (!value) return null;
  requireSecret(secret);

  try {
    const packed = fromBase64Url(value);
    if (packed.length <= IV_BYTES) return null;

    const key = await deriveKey(secret);
    // Copied rather than subarray'd: a view shares the parent buffer and types as
    // ArrayBufferLike, which is not a valid BufferSource for Web Crypto.
    const iv = new Uint8Array(packed.subarray(0, IV_BYTES));
    const ciphertext = new Uint8Array(packed.subarray(IV_BYTES));

    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    const session = JSON.parse(new TextDecoder().decode(plaintext)) as Session;

    if (!isSession(session)) return null;
    if (session.expiresAt <= now) return null;

    return session;
  } catch {
    return null;
  }
}

function isSession(value: unknown): value is Session {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Partial<Session>;
  return (
    typeof s.baseUrl === 'string' &&
    typeof s.tenant === 'string' &&
    typeof s.token === 'string' &&
    typeof s.username === 'string' &&
    typeof s.expiresAt === 'number'
  );
}

function requireSecret(secret: string): void {
  // A short secret here would undermine every cookie the deployment issues, so this
  // fails loudly at startup rather than degrading quietly.
  if (!secret || secret.length < 32) {
    throw new Error(
      'AUTH_SECRET must be set to at least 32 characters. ' +
        'Generate one with: openssl rand -base64 48',
    );
  }
}

export const SESSION_COOKIE = 'pgm_session';

/** Cookie attributes. Shared so the set and clear paths cannot drift apart. */
export function sessionCookieOptions(maxAgeSeconds: number) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: 'strict' as const,
    path: '/',
    maxAge: maxAgeSeconds,
  };
}
