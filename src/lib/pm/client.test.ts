import { test } from 'node:test';
import assert from 'node:assert/strict';

import { backoffMs, buildUrl, isPmError, pmRequest, type PmContext } from './client.ts';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** A fetch stub that replays a queue of responses and records what it was sent. */
function stub(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body as string | undefined,
    });
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    // Clone: a Response body can only be consumed once, and the queue replays its
    // last entry across retries. Returning the same object would hand the second
    // attempt an already-drained body and quietly fake an empty error payload.
    return (next as Response).clone();
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, count: () => i };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const slept: number[] = [];
function ctx(fetchImpl: typeof fetch, over: Partial<PmContext> = {}): PmContext {
  return {
    baseUrl: 'https://demo.promapp.com',
    tenant: '93555a16ceb24f139a6e8a40618d3f8b',
    token: 'tok',
    fetch: fetchImpl,
    sleep: async (ms) => {
      slept.push(ms);
    },
    ...over,
  };
}

test('builds tenant-scoped URLs with query parameters', () => {
  const c = ctx(stub([]).fetchImpl);
  assert.equal(
    buildUrl(c, '/Process/View/GetChildProcessGroupTreeItems', { uniqueId: 'abc' }),
    'https://demo.promapp.com/93555a16ceb24f139a6e8a40618d3f8b/Process/View/GetChildProcessGroupTreeItems?uniqueId=abc',
  );
});

test('undefined query values are omitted, not sent as "undefined"', () => {
  const c = ctx(stub([]).fetchImpl);
  const url = buildUrl(c, '/x', { a: 'keep', b: undefined });
  assert.match(url, /\?a=keep$/);
});

test('sends the headers Process Manager expects', () => {
  const s = stub([json({ ok: true })]);
  return pmRequest(ctx(s.fetchImpl, { antiforgeryToken: 'af-token' }), { path: '/x' }).then(() => {
    const h = s.calls[0]!.headers;
    assert.equal(h['Authorization'], 'Bearer tok');
    // Without this some MVC endpoints return HTML instead of JSON.
    assert.equal(h['X-Requested-With'], 'XMLHttpRequest');
    assert.equal(h['__RequestVerificationToken'], 'af-token');
  });
});

test('omits the antiforgery header when there is no token', async () => {
  const s = stub([json({})]);
  await pmRequest(ctx(s.fetchImpl), { path: '/x' });
  assert.equal('__RequestVerificationToken' in s.calls[0]!.headers, false);
});

test('serialises a JSON body', async () => {
  const s = stub([json({})]);
  await pmRequest(ctx(s.fetchImpl), {
    path: '/Process/Edit/CreateGroup',
    method: 'POST',
    body: { parentProcessGroupUniqueId: '' },
  });
  assert.equal(s.calls[0]!.headers['Content-Type'], 'application/json');
  assert.equal(s.calls[0]!.body, '{"parentProcessGroupUniqueId":""}');
});

test('serialises a form body for the token endpoint', async () => {
  const s = stub([json({})]);
  await pmRequest(ctx(s.fetchImpl), {
    path: '/oauth2/token',
    method: 'POST',
    form: { grant_type: 'password', username: 'u', password: 'p p' },
  });
  assert.equal(s.calls[0]!.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.match(s.calls[0]!.body!, /password=p\+p/);
});

test('treats 204 as success with no body', async () => {
  // The process PUT answers 204; parsing it as JSON would throw.
  const s = stub([new Response(null, { status: 204 })]);
  const result = await pmRequest(ctx(s.fetchImpl), { path: '/x', method: 'PUT', retry: 'write' });
  assert.equal(result, undefined);
});

test('retries a read on 500 and succeeds', async () => {
  const s = stub([json({ e: 1 }, 500), json({ ok: true })]);
  const result = await pmRequest<{ ok: boolean }>(ctx(s.fetchImpl), { path: '/x' });
  assert.deepEqual(result, { ok: true });
  assert.equal(s.count(), 2);
});

test('does NOT retry a write on 500', async () => {
  // The server may have applied it. Repeating CreateGroup would orphan a group.
  const s = stub([json({ e: 1 }, 500)]);
  await assert.rejects(
    pmRequest(ctx(s.fetchImpl), { path: '/x', method: 'POST', retry: 'write' }),
    (e: unknown) => isPmError(e) && e.status === 500,
  );
  assert.equal(s.count(), 1);
});

test('does retry a write on 429, which cannot have been applied', async () => {
  const s = stub([json({}, 429), json({ ok: true })]);
  const result = await pmRequest<{ ok: boolean }>(ctx(s.fetchImpl), {
    path: '/x',
    method: 'POST',
    retry: 'write',
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(s.count(), 2);
});

test('never retries a 4xx', async () => {
  const s = stub([json({ e: 'bad' }, 400)]);
  await assert.rejects(pmRequest(ctx(s.fetchImpl), { path: '/x' }));
  assert.equal(s.count(), 1);
});

test('a 401 surfaces its status so the UI can ask for sign-in again', async () => {
  const s = stub([json({}, 401)]);
  await assert.rejects(
    pmRequest(ctx(s.fetchImpl), { path: '/x' }),
    (e: unknown) => isPmError(e) && e.status === 401,
  );
});

test('gives up after the attempt limit', async () => {
  const s = stub([json({}, 503)]);
  await assert.rejects(pmRequest(ctx(s.fetchImpl), { path: '/x', attempts: 3 }));
  assert.equal(s.count(), 3);
});

test('a network error on a write is not retried', async () => {
  // Ambiguous: the request may have reached the server.
  const s = stub([new TypeError('socket hang up')]);
  await assert.rejects(
    pmRequest(ctx(s.fetchImpl), { path: '/x', method: 'POST', retry: 'write' }),
    (e: unknown) => isPmError(e) && e.status === null,
  );
  assert.equal(s.count(), 1);
});

test('a network error on a read is retried', async () => {
  const s = stub([new TypeError('socket hang up'), json({ ok: true })]);
  const result = await pmRequest<{ ok: boolean }>(ctx(s.fetchImpl), { path: '/x' });
  assert.deepEqual(result, { ok: true });
});

test('errors carry the response body for diagnosis', async () => {
  const s = stub([new Response('Invalid tag family for a procedure', { status: 500 })]);
  await assert.rejects(
    pmRequest(ctx(s.fetchImpl), { path: '/x' }, ),
    (e: unknown) => isPmError(e) && /Invalid tag family/.test(e.bodyText),
  );
});

test('backoff grows exponentially and yields to Retry-After', () => {
  assert.equal(backoffMs(1, null), 3_000);
  assert.equal(backoffMs(2, null), 6_000);
  assert.equal(backoffMs(3, null), 12_000);
  // A server-specified delay always wins over our guess.
  assert.equal(backoffMs(3, 500), 500);
});

test('honours a Retry-After header', async () => {
  slept.length = 0;
  const s = stub([json({}, 429, { 'retry-after': '2' }), json({ ok: true })]);
  await pmRequest(ctx(s.fetchImpl), { path: '/x' });
  assert.deepEqual(slept, [2_000]);
});
