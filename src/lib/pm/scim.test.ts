import assert from 'node:assert/strict';
import { test } from 'node:test';

import { indexUsersByLogon, isScimError, listDirectoryUsers, scimBaseUrl } from './scim.ts';

test('SCIM is one host for every tenant, whatever origin the tenant is served from', () => {
  assert.equal(scimBaseUrl(), 'https://api.promapp.com');
  assert.equal(scimBaseUrl('https://scim.test/'), 'https://scim.test');
});

function page(users: Array<{ id: string; userName: string }>, totalResults: number) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      Resources: users.map((u) => ({
        id: u.id,
        userName: u.userName,
        name: { givenName: 'Given', familyName: 'Family' },
        active: true,
      })),
      totalResults,
    }),
  } as unknown as Response;
}

test('every page is read, and the walk ends at totalResults', () => {
  return (async () => {
    const requested: string[] = [];
    const pages = [
      page([{ id: '1', userName: 'a' }, { id: '2', userName: 'b' }], 3),
      page([{ id: '3', userName: 'c' }], 3),
    ];

    const users = await listDirectoryUsers({
      baseUrl: 'https://api.promapp.com',
      apiKey: 'key',
      fetch: (async (url: string) => {
        requested.push(new URL(url).searchParams.get('startIndex') ?? '');
        return pages.shift() ?? page([], 3);
      }) as unknown as typeof fetch,
    });

    assert.deepEqual(users.map((u) => u.userId), [1, 2, 3]);
    assert.deepEqual(requested, ['1', '3']);
  })();
});

test('an empty page ends the walk even when the count disagrees', async () => {
  let calls = 0;
  const users = await listDirectoryUsers({
    baseUrl: 'https://api.promapp.com',
    apiKey: 'key',
    fetch: (async () => {
      calls += 1;
      // A totalResults that never arrives would otherwise spin to the page cap.
      return page([], 900);
    }) as unknown as typeof fetch,
  });

  assert.deepEqual(users, []);
  assert.equal(calls, 1);
});

test('a rejected key is a ScimError, not something that reads as a dead session', async () => {
  // The distinction matters: the proxy signs the operator out on a Process Manager 401.
  await assert.rejects(
    listDirectoryUsers({
      baseUrl: 'https://api.promapp.com',
      apiKey: 'wrong',
      fetch: (async () =>
        ({ ok: false, status: 401, json: async () => ({}) }) as unknown as Response) as typeof fetch,
    }),
    (error: unknown) => isScimError(error) && /SCIM API key/.test((error as Error).message),
  );
});

test('users with no id or no logon are dropped rather than carried as unusable', async () => {
  const users = await listDirectoryUsers({
    baseUrl: 'https://api.promapp.com',
    apiKey: 'key',
    fetch: (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          Resources: [
            { id: null, userName: 'no-id' },
            { id: '7', userName: '  ' },
            { id: '8', userName: 'fine', name: { givenName: 'A', familyName: 'B' } },
          ],
          totalResults: 3,
        }),
      }) as unknown as Response) as typeof fetch,
  });

  assert.deepEqual(users.map((u) => u.logon), ['fine']);
  assert.equal(users[0]?.displayName, 'A B');
});

test('logons match case-insensitively, and a collision refuses to guess', () => {
  const index = indexUsersByLogon([
    { userId: 1, logon: 'Ricco.Ugas@Nintex.com', displayName: 'Ricco', active: true },
    { userId: 2, logon: 'shared', displayName: 'One', active: true },
    { userId: 3, logon: 'SHARED', displayName: 'Two', active: true },
  ]);

  assert.equal((index.get('ricco.ugas@nintex.com') as { userId: number }).userId, 1);
  assert.equal(index.get('shared'), 'ambiguous');
  assert.equal(index.get('missing'), undefined);
});
