import { test } from 'node:test';
import assert from 'node:assert/strict';

import { seal, unseal, type Session } from './session.ts';

const SECRET = 'a'.repeat(48);
const OTHER_SECRET = 'b'.repeat(48);

function session(over: Partial<Session> = {}): Session {
  return {
    baseUrl: 'https://demo.promapp.com',
    tenant: '93555a16ceb24f139a6e8a40618d3f8b',
    token: 'bearer-token-value',
    expiresAt: Date.now() + 60_000,
    username: 'jonathan',
    ...over,
  };
}

test('a sealed session round-trips', async () => {
  const original = session();
  const restored = await unseal(await seal(original, SECRET), SECRET);
  assert.deepEqual(restored, original);
});

test('the sealed value does not leak the token', async () => {
  // The cookie travels to the browser; the bearer token must not be readable in it.
  const sealed = await seal(session({ token: 'super-secret-token' }), SECRET);
  assert.equal(sealed.includes('super-secret-token'), false);
  assert.equal(sealed.includes('promapp'), false);
});

test('sealing twice produces different ciphertext', async () => {
  // A fresh IV each time; identical cookies would leak that nothing changed.
  const fixed = session({ expiresAt: 4_000_000_000_000 });
  assert.notEqual(await seal(fixed, SECRET), await seal(fixed, SECRET));
});

test('a different secret cannot unseal', async () => {
  const sealed = await seal(session(), SECRET);
  assert.equal(await unseal(sealed, OTHER_SECRET), null);
});

test('tampering with the ciphertext is detected', async () => {
  // GCM is authenticated: a flipped byte must fail, not decrypt to altered data.
  const sealed = await seal(session(), SECRET);
  const chars = [...sealed];
  const i = chars.length - 3;
  chars[i] = chars[i] === 'A' ? 'B' : 'A';
  assert.equal(await unseal(chars.join(''), SECRET), null);
});

test('an expired session is rejected', async () => {
  const sealed = await seal(session({ expiresAt: 1_000 }), SECRET);
  assert.equal(await unseal(sealed, SECRET, 2_000), null);
});

test('expiry is checked at exactly the boundary', async () => {
  const sealed = await seal(session({ expiresAt: 5_000 }), SECRET);
  assert.equal(await unseal(sealed, SECRET, 5_000), null);
  assert.notEqual(await unseal(sealed, SECRET, 4_999), null);
});

test('missing, empty, and malformed cookies are all just "not signed in"', async () => {
  assert.equal(await unseal(undefined, SECRET), null);
  assert.equal(await unseal(null, SECRET), null);
  assert.equal(await unseal('', SECRET), null);
  assert.equal(await unseal('not-base64!!', SECRET), null);
  assert.equal(await unseal('short', SECRET), null);
});

test('a payload missing required fields is rejected', async () => {
  // Guards against a cookie shape from an older release being trusted.
  const partial = { baseUrl: 'x', tenant: 'y', expiresAt: Date.now() + 1000 };
  const sealed = await seal(partial as unknown as Session, SECRET);
  assert.equal(await unseal(sealed, SECRET), null);
});

test('a weak secret is refused outright', async () => {
  await assert.rejects(() => seal(session(), 'too-short'), /at least 32 characters/);
  await assert.rejects(() => unseal('anything', ''), /AUTH_SECRET/);
});

test('values with URL-unsafe bytes survive the encoding', async () => {
  const tricky = session({ token: 'a+b/c=d?e&f#g', username: 'jörg müller' });
  const restored = await unseal(await seal(tricky, SECRET), SECRET);
  assert.deepEqual(restored, tricky);
});
