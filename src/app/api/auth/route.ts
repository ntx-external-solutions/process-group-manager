/**
 * Sign in and sign out.
 *
 * The password reaches this handler, is exchanged for a bearer token, and is then
 * gone — it is never stored, logged, or written into the session. The token is sealed
 * into an httpOnly cookie so neither page scripts nor any server-side store hold it.
 */

import { NextResponse } from 'next/server';

import { SESSION_COOKIE, seal, sessionCookieOptions } from '@/lib/auth/session.ts';
import { parseSiteAddress, requestToken } from '@/lib/auth/token.ts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SignInBody {
  site?: unknown;
  username?: unknown;
  password?: unknown;
}

export async function POST(request: Request): Promise<NextResponse> {
  const secret = process.env['AUTH_SECRET'];
  if (!secret || secret.length < 32) {
    // A deployment misconfiguration, not a user error — say so rather than
    // presenting it as a failed sign-in.
    return NextResponse.json(
      { error: 'This deployment is missing AUTH_SECRET. Contact whoever set it up.' },
      { status: 500 },
    );
  }

  let body: SignInBody;
  try {
    body = (await request.json()) as SignInBody;
  } catch {
    return NextResponse.json({ error: 'Malformed request.' }, { status: 400 });
  }

  const { site, username, password } = body;
  if (typeof site !== 'string' || typeof username !== 'string' || typeof password !== 'string') {
    return NextResponse.json({ error: 'Site, username and password are required.' }, { status: 400 });
  }

  const address = parseSiteAddress(site);
  if (!address) {
    return NextResponse.json(
      {
        error:
          'That does not look like a Process Manager address. ' +
          'Paste the full URL including the part after the domain, ' +
          'for example https://demo.promapp.com/your-tenant.',
      },
      { status: 400 },
    );
  }

  const grant = await requestToken({
    baseUrl: address.baseUrl,
    tenant: address.tenant,
    username,
    password,
    fetch,
  });

  if (!grant.ok) {
    return NextResponse.json({ error: grant.message }, { status: grant.status ?? 502 });
  }

  const cookie = await seal(
    {
      baseUrl: address.baseUrl,
      tenant: address.tenant,
      token: grant.token,
      expiresAt: grant.expiresAt,
      username,
    },
    secret,
  );

  const maxAge = Math.max(60, Math.floor((grant.expiresAt - Date.now()) / 1000));
  const response = NextResponse.json({
    ok: true,
    tenant: address.tenant,
    baseUrl: address.baseUrl,
    username,
    expiresAt: grant.expiresAt,
  });
  response.cookies.set(SESSION_COOKIE, cookie, sessionCookieOptions(maxAge));
  return response;
}

/** Sign out. Clearing the cookie is sufficient — there is no server-side state. */
export async function DELETE(): Promise<NextResponse> {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, '', sessionCookieOptions(0));
  return response;
}
