import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PmContext } from './client.ts';
import {
  execute,
  parseOperation,
  type Operation,
  type ProcessSummary,
  type SetShortcutsResult,
} from './operations.ts';

const PROCESS = '38c70a88-18a6-4b94-8ed7-c6fa0820852a';

function processResponse(over: { revisionEditId?: number; shortcuts?: unknown } = {}) {
  return {
    processJson: {
      Id: 1537,
      UniqueId: PROCESS,
      Name: 'First Process',
      GroupId: 815,
      GroupUniqueId: '33b62df0-f0b8-45a5-8cbb-555f8439b2f4',
      Group: 'Example Group',
      Version: '2.0',
      Objective: 'Test',
      ProcessRevisionEditId: over.revisionEditId ?? 9180,
      ProcessRevisionStateId: 3,
      ProcessGroupItems: {
        ProcessGroup: {
          Id: 815,
          UniqueId: '33b62df0-f0b8-45a5-8cbb-555f8439b2f4',
          Name: 'Example Group',
        },
        ProcessGroupShortcut: over.shortcuts ?? null,
      },
    },
    processActions: {
      CanSave: true,
      CanPublishAfterEdit: false,
      CanSubmitForApprovalAfterEdit: true,
    },
  };
}

function harness(responses: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
    });
    const payload = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (payload === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const ctx: PmContext = {
    baseUrl: 'https://demo.promapp.com',
    tenant: 'tenant',
    token: 'tok',
    fetch: fetchImpl,
    sleep: async () => {},
  };
  return { ctx, calls };
}

// ------------------------------------------------------------- allowlisting

test('an unknown operation is refused', () => {
  const result = parseOperation({ op: 'groups.delete', uniqueId: 'x' });
  assert.equal(result.ok, false);
  assert.ok(!result.ok);
  assert.match(result.error, /Unknown operation/);
});

test('there is no way to name a URL', () => {
  // The whole point of the allowlist: no caller-supplied path can reach fetch.
  for (const attempt of [
    { op: 'raw', url: 'https://evil.example/' },
    { op: 'groups.tree', url: 'https://evil.example/', parentUniqueId: null, path: '/anything' },
  ]) {
    const result = parseOperation(attempt);
    if (result.ok) {
      assert.equal('url' in result.operation, false);
      assert.equal('path' in result.operation, false);
    }
  }
});

test('non-object bodies are refused', () => {
  for (const bad of [null, 'string', 42, []]) {
    assert.equal(parseOperation(bad).ok, false);
  }
});

test('groups.tree accepts null for the root level', () => {
  const result = parseOperation({ op: 'groups.tree', parentUniqueId: null });
  assert.ok(result.ok);
  assert.deepEqual(result.operation, { op: 'groups.tree', parentUniqueId: null });
});

test('groups.tree rejects a non-string parent', () => {
  assert.equal(parseOperation({ op: 'groups.tree', parentUniqueId: 42 }).ok, false);
});

test('groups.rename requires both fields', () => {
  assert.equal(parseOperation({ op: 'groups.rename', uniqueId: 'x' }).ok, false);
  assert.equal(parseOperation({ op: 'groups.rename', name: 'x' }).ok, false);
  // Whitespace-only is not a name.
  assert.equal(parseOperation({ op: 'groups.rename', uniqueId: 'x', name: '  ' }).ok, false);
});

test('groupIds must be an array of numbers', () => {
  assert.equal(parseOperation({ op: 'groups.permissions', groupIds: ['1'] }).ok, false);
  assert.equal(parseOperation({ op: 'groups.permissions', groupIds: 'all' }).ok, false);
  assert.ok(parseOperation({ op: 'groups.permissions', groupIds: [1, 2] }).ok);
});

test('setShortcuts requires a revision to check against', () => {
  // Without it the write could silently clobber someone else's edit.
  const result = parseOperation({
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    changeDescription: 'x',
    shortcuts: [],
  });
  assert.equal(result.ok, false);
});

test('shortcut refs are rebuilt field by field', () => {
  // Anything extra the caller attaches must not survive into the PM payload.
  const result = parseOperation({
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    changeDescription: 'x',
    expectedRevisionEditId: 9180,
    shortcuts: [{ Id: 1, UniqueId: 'u', Name: 'n', Injected: 'nope' }],
  });
  assert.ok(result.ok);
  const op = result.operation as Extract<Operation, { op: 'process.setShortcuts' }>;
  assert.deepEqual(op.shortcuts, [{ Id: 1, UniqueId: 'u', Name: 'n' }]);
});

test('malformed shortcut refs are refused', () => {
  const result = parseOperation({
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    changeDescription: 'x',
    expectedRevisionEditId: 1,
    shortcuts: [{ Id: 'not-a-number', UniqueId: 'u', Name: 'n' }],
  });
  assert.equal(result.ok, false);
});

test('submitForApproval defaults to false rather than being inferred', () => {
  const result = parseOperation({
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    changeDescription: 'x',
    expectedRevisionEditId: 1,
    shortcuts: [],
  });
  assert.ok(result.ok);
  const op = result.operation as Extract<Operation, { op: 'process.setShortcuts' }>;
  assert.equal(op.submitForApproval, false);
});

// -------------------------------------------------------------- execution

test('process.summary returns only what the planner needs', async () => {
  const h = harness([processResponse({ shortcuts: [{ Id: 770, UniqueId: 'sc-1', Name: 'My Group' }] })]);
  const summary = (await execute(h.ctx, {
    op: 'process.summary',
    processUniqueId: PROCESS,
  })) as ProcessSummary;

  assert.deepEqual(summary.currentShortcutIds, ['sc-1']);
  assert.equal(summary.revisionStateId, 3);
  assert.equal(summary.canPublishAfterEdit, false);
  assert.equal(summary.canSubmitForApprovalAfterEdit, true);
  // The full process document must not travel to the browser.
  assert.equal('processJson' in (summary as object), false);
  assert.equal('Objective' in (summary as object), false);
});

test('setShortcuts writes and reports the new revision', async () => {
  const h = harness([
    processResponse({ revisionEditId: 9180 }),
    undefined, // PUT -> 204
    { latestProcessRevisionEditId: 9181 },
  ]);

  const result = (await execute(h.ctx, {
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    shortcuts: [{ Id: 770, UniqueId: 'sc-1', Name: 'My Group' }],
    changeDescription: 'Updated shortcuts',
    expectedRevisionEditId: 9180,
    submitForApproval: false,
  })) as SetShortcutsResult;

  assert.equal(result.ok, true);
  assert.equal(result.revisionEditId, 9181);

  const put = h.calls[1]!;
  assert.equal(put.method, 'PUT');
  const envelope = JSON.parse(put.body!);
  // Bulk runs must never notify.
  assert.equal(envelope.SuppressChangeNotification, true);
  const sent = JSON.parse(envelope.ProcessJson);
  assert.deepEqual(sent.ProcessGroupItems.ProcessGroupShortcut, [
    { Id: 770, UniqueId: 'sc-1', Name: 'My Group' },
  ]);
});

test('setShortcuts changes nothing else in the document', async () => {
  const h = harness([processResponse(), undefined, { latestProcessRevisionEditId: 9181 }]);
  await execute(h.ctx, {
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    shortcuts: [],
    changeDescription: 'Clear',
    expectedRevisionEditId: 9180,
    submitForApproval: false,
  });

  const sent = JSON.parse(JSON.parse(h.calls[1]!.body!).ProcessJson);
  assert.equal(sent.Objective, 'Test');
  assert.equal(sent.Name, 'First Process');
  assert.equal(sent.ProcessGroupItems.ProcessGroup.UniqueId, '33b62df0-f0b8-45a5-8cbb-555f8439b2f4');
});

test('a revision that moved since planning aborts the write', async () => {
  // Someone edited the process in the meantime; overwriting would discard their work.
  const h = harness([processResponse({ revisionEditId: 9999 })]);
  const result = (await execute(h.ctx, {
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    shortcuts: [],
    changeDescription: 'x',
    expectedRevisionEditId: 9180,
    submitForApproval: false,
  })) as SetShortcutsResult;

  assert.equal(result.ok, false);
  assert.deepEqual(result.conflict, { expected: 9180, actual: 9999 });
  // Read only — nothing was written.
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0]!.method, 'GET');
});

test('submitForApproval reaches the envelope when asked for', async () => {
  const h = harness([processResponse(), undefined, { latestProcessRevisionEditId: 9181 }]);
  await execute(h.ctx, {
    op: 'process.setShortcuts',
    processUniqueId: PROCESS,
    shortcuts: [],
    changeDescription: 'x',
    expectedRevisionEditId: 9180,
    submitForApproval: true,
  });
  assert.equal(JSON.parse(h.calls[1]!.body!).DoSubmitForApproval, true);
});

// ---------------------------------------------------------------- listing

test('processes.list requires a positive integer page', () => {
  assert.equal(parseOperation({ op: 'processes.list', page: 0 }).ok, false);
  assert.equal(parseOperation({ op: 'processes.list', page: 1.5 }).ok, false);
  assert.equal(parseOperation({ op: 'processes.list', page: '1' }).ok, false);
  assert.ok(parseOperation({ op: 'processes.list', page: 1 }).ok);
});

test('processes.list defaults to active processes', () => {
  const result = parseOperation({ op: 'processes.list', page: 1 });
  assert.ok(result.ok);
  assert.deepEqual(result.operation, { op: 'processes.list', page: 1, listType: 0 });
});

test('processes.list sends the paging parameters the endpoint needs', async () => {
  const h = harness([{ items: [], totalItemCount: 0 }]);
  await execute(h.ctx, { op: 'processes.list', page: 3, listType: 7 });
  assert.match(h.calls[0]!.url, /\/Bff\/Process\/api\/v1\/processes\?/);
  assert.match(h.calls[0]!.url, /Page=3/);
  assert.match(h.calls[0]!.url, /PageSize=200/);
  assert.match(h.calls[0]!.url, /ListType=7/);
});

test('processes.exportCsv returns the report as text, not parsed JSON', async () => {
  const csv = 'Process ID,Process Name\n6a9779c8-70b8-45d8-bb36-9de47b9fbf7c,PQL via BDR';
  const calls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
  }) as unknown as typeof fetch;

  const result = (await execute(
    { baseUrl: 'https://demo.promapp.com', tenant: 't', token: 'tok', fetch: fetchImpl },
    { op: 'processes.exportCsv' },
  )) as { csv: string };

  assert.match(calls[0]!, /\/exports\/api\/v1\/reports\/ProcessListReport\/csv$/);
  // Parsing this as JSON would throw; the text path is what makes it work.
  assert.equal(result.csv, csv);
});

test('processes.exportCsv takes no caller-supplied parameters', () => {
  const result = parseOperation({ op: 'processes.exportCsv', path: '/anything', url: 'https://evil' });
  assert.ok(result.ok);
  assert.deepEqual(result.operation, { op: 'processes.exportCsv' });
});
