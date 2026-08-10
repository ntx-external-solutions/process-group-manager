/**
 * Cookie header parsing.
 *
 * Kept out of the route handler so it can be tested as a plain function, without
 * pulling the Next.js server runtime into the test process.
 */

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;

    const raw = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      // A malformed percent-escape is not worth throwing over; the value simply
      // will not unseal, which the caller already handles as "not signed in".
      return raw;
    }
  }

  return null;
}
