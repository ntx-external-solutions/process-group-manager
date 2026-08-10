import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSiteAddress, requestToken } from './token.ts';

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const base = {
  baseUrl: 'https://demo.promapp.com',
  tenant: '93555a16ceb24f139a6e8a40618d3f8b',
  username: 'jonathan',
  password: 'pa ss+word',
};

test('posts the password grant to the tenant token endpoint', async () => {
  const s = stubFetch(() => json({ access_token: 'tok', expires_in: 3600 }));
  await requestToken({ ...base, fetch: s.impl });

  assert.equal(
    s.calls[0]!.url,
    'https://demo.promapp.com/93555a16ceb24f139a6e8a40618d3f8b/oauth2/token',
  );
  const body = String(s.calls[0]!.init.body);
  assert.match(body, /grant_type=password/);
  // Form-encoded, so a password with spaces and plus signs survives intact.
  assert.match(body, /password=pa\+ss%2Bword/);
});

test('returns the token and an expiry derived from expires_in', async () => {
  const s = stubFetch(() => json({ access_token: 'tok', expires_in: 3600 }));
  const before = Date.now();
  const result = await requestToken({ ...base, fetch: s.impl });

  assert.ok(result.ok);
  assert.equal(result.token, 'tok');
  assert.ok(result.expiresAt >= before + 3_600_000);
  assert.ok(result.expiresAt <= Date.now() + 3_600_000);
});

test('falls back to a working-day lifetime when expires_in is absent', async () => {
  // The response shape is unconfirmed, so a missing field must not mean "expired".
  const s = stubFetch(() => json({ access_token: 'tok' }));
  const result = await requestToken({ ...base, fetch: s.impl });
  assert.ok(result.ok);
  assert.ok(result.expiresAt > Date.now() + 7 * 60 * 60 * 1000);
});

test('accepts a PascalCase token field', async () => {
  const s = stubFetch(() => json({ AccessToken: 'tok' }));
  const result = await requestToken({ ...base, fetch: s.impl });
  assert.ok(result.ok);
  assert.equal(result.token, 'tok');
});

test('bad credentials produce a plain-language failure', async () => {
  const s = stubFetch(() => json({ error: 'invalid_grant' }, 400));
  const result = await requestToken({ ...base, fetch: s.impl });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.message, /Check the username and password/);
});

test('a server error is reported with its status', async () => {
  const s = stubFetch(() => json({}, 503));
  const result = await requestToken({ ...base, fetch: s.impl });
  assert.ok(!result.ok);
  assert.match(result.message, /HTTP 503/);
});

test('a network failure never echoes the request', async () => {
  // The request body contains the password; the error must not carry it onward.
  const s = stubFetch(() => {
    throw new TypeError(`fetch failed for body password=${base.password}`);
  });
  const result = await requestToken({ ...base, fetch: s.impl });
  assert.ok(!result.ok);
  assert.equal(result.message.includes(base.password), false);
  assert.match(result.message, /Could not reach Process Manager/);
});

test('a success response with no token is a failure, not a broken session', async () => {
  const s = stubFetch(() => json({ token_type: 'bearer' }));
  const result = await requestToken({ ...base, fetch: s.impl });
  assert.ok(!result.ok);
  assert.match(result.message, /did not return an access token/);
});

test('an unreadable body is handled', async () => {
  const s = stubFetch(() => new Response('<html>login</html>', { status: 200 }));
  const result = await requestToken({ ...base, fetch: s.impl });
  assert.ok(!result.ok);
  assert.match(result.message, /unreadable/);
});

// ------------------------------------------------------------- site address

test('parses the address an operator would actually paste', () => {
  // Straight from the browser bar, tenant path and all.
  assert.deepEqual(
    parseSiteAddress('https://demo.promapp.com/93555a16ceb24f139a6e8a40618d3f8b/Admin'),
    { baseUrl: 'https://demo.promapp.com', tenant: '93555a16ceb24f139a6e8a40618d3f8b' },
  );
});

test('tolerates a missing scheme and a trailing slash', () => {
  assert.deepEqual(parseSiteAddress('au.promapp.com/mundaring/'), {
    baseUrl: 'https://au.promapp.com',
    tenant: 'mundaring',
  });
});

test('rejects an address with no tenant segment', () => {
  assert.equal(parseSiteAddress('https://demo.promapp.com'), null);
  assert.equal(parseSiteAddress('https://demo.promapp.com/'), null);
});

test('rejects empty or unparseable input', () => {
  assert.equal(parseSiteAddress(''), null);
  assert.equal(parseSiteAddress('   '), null);
  assert.equal(parseSiteAddress('http://'), null);
});
