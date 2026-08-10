/**
 * Contract tests.
 *
 * Request shapes are asserted against what the live product actually sent, and
 * response fixtures are lifted verbatim from the HAR captures described in DESIGN.md.
 * The point is to fail here rather than against a customer tenant.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PmContext } from './client.ts';
import { createGroup, getChildGroups, renameGroup, validateGroupAction } from './groups.ts';
import {
  buildUpdateEnvelope,
  currentShortcuts,
  getLatestRevision,
  publishProcess,
  updateProcess,
  withShortcuts,
} from './processes.ts';
import type { ProcessJson } from './types.ts';

interface Call {
  url: string;
  method: string;
  body: string | undefined;
}

function harness(responses: unknown[]) {
  const calls: Call[] = [];
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
    tenant: '93555a16ceb24f139a6e8a40618d3f8b',
    token: 'tok',
    fetch: fetchImpl,
    sleep: async () => {},
  };
  return { ctx, calls };
}

// ---------------------------------------------------------------- groups

test('getChildGroups sends an empty uniqueId for the root level', async () => {
  const h = harness([{ treeItems: [], parentUniqueId: null }]);
  await getChildGroups(h.ctx, null);
  assert.match(h.calls[0]!.url, /GetChildProcessGroupTreeItems\?uniqueId=$/);
});

test('getChildGroups parses a real tree response', async () => {
  // Verbatim from the group-creation capture.
  const fixture = {
    treeItems: [
      {
        id: 1537,
        uniqueId: '38c70a88-18a6-4b94-8ed7-c6fa0820852a',
        title: 'Copy of First Process',
        itemType: 'inprogress-process',
        itemOrder: 0,
        hasChild: null,
        totalSubgroups: null,
        totalStakeholderUsers: null,
        totalPermissionRoles: null,
        totalPermissionUsers: null,
        variationSetId: null,
      },
      {
        id: 815,
        uniqueId: '33b62df0-f0b8-45a5-8cbb-555f8439b2f4',
        title: 'Example Group',
        itemType: 'group',
        itemOrder: 1,
        hasChild: true,
        totalSubgroups: 1,
        totalStakeholderUsers: 0,
        totalPermissionRoles: 1,
        totalPermissionUsers: 0,
        variationSetId: null,
      },
    ],
    parentUniqueId: 'd0ec5eca-c757-4af8-bdfc-ee1ff3080baf',
  };
  const h = harness([fixture]);
  const result = await getChildGroups(h.ctx, 'd0ec5eca-c757-4af8-bdfc-ee1ff3080baf');
  assert.equal(result.treeItems?.length, 2);
  assert.equal(result.treeItems?.[1]?.itemType, 'group');
});

test('validateGroupAction sends actionType 1 for a create', async () => {
  const h = harness([{ isValid: true, isPrompt: false }]);
  await validateGroupAction(h.ctx, null);
  assert.match(h.calls[0]!.url, /ValidateGroupAction\?processGroupUniqueId=&actionType=1$/);
});

test('createGroup posts the parent id and reads the server-spelled groupid', async () => {
  // Response verbatim from the capture, including "groupid" and "New Group".
  const h = harness([
    {
      isValid: true,
      parentGroupId: 'd0ec5eca-c757-4af8-bdfc-ee1ff3080baf',
      groupid: '33b62df0-f0b8-45a5-8cbb-555f8439b2f4',
      groupName: 'New Group',
      direction: 'R',
    },
  ]);
  const result = await createGroup(h.ctx, 'd0ec5eca-c757-4af8-bdfc-ee1ff3080baf');
  assert.equal(h.calls[0]!.method, 'POST');
  assert.equal(
    h.calls[0]!.body,
    '{"parentProcessGroupUniqueId":"d0ec5eca-c757-4af8-bdfc-ee1ff3080baf"}',
  );
  assert.equal(result.groupid, '33b62df0-f0b8-45a5-8cbb-555f8439b2f4');
});

test('createGroup sends an empty string for a top-level group', async () => {
  const h = harness([{ isValid: true, groupid: 'x', groupName: 'New Group' }]);
  await createGroup(h.ctx, null);
  assert.equal(h.calls[0]!.body, '{"parentProcessGroupUniqueId":""}');
});

test('renameGroup posts the id and the new name', async () => {
  const h = harness([{ isValid: true }]);
  await renameGroup(h.ctx, '33b62df0-f0b8-45a5-8cbb-555f8439b2f4', 'Example Group');
  assert.equal(
    h.calls[0]!.body,
    '{"processGroupUniqueId":"33b62df0-f0b8-45a5-8cbb-555f8439b2f4","newName":"Example Group"}',
  );
});

// ---------------------------------------------------------------- processes

function processFixture(): ProcessJson {
  return {
    Id: 1537,
    UniqueId: '38c70a88-18a6-4b94-8ed7-c6fa0820852a',
    Name: 'First Process',
    GroupId: 815,
    GroupUniqueId: '33b62df0-f0b8-45a5-8cbb-555f8439b2f4',
    Group: 'Example Group',
    Version: '2.0',
    ProcessRevisionEditId: 9180,
    ProcessRevisionStateId: 3,
    Objective: 'Test',
    ProcessGroupItems: {
      ProcessGroup: {
        Id: 815,
        UniqueId: '33b62df0-f0b8-45a5-8cbb-555f8439b2f4',
        Name: 'Example Group',
      },
      ProcessGroupShortcut: null,
    },
  };
}

test('the PUT body double-serialises ProcessJson', async () => {
  // Sending the object directly returns HTTP 500 — this is the whole reason the
  // envelope builder exists.
  const envelope = buildUpdateEnvelope(processFixture(), { changeDescription: 'Updated' });
  assert.equal(typeof envelope.ProcessJson, 'string');
  assert.equal(JSON.parse(envelope.ProcessJson).UniqueId, '38c70a88-18a6-4b94-8ed7-c6fa0820852a');
});

test('change notifications are suppressed unless explicitly opted out', () => {
  // At ~1,518 processes the default matters more than almost anything else here.
  const envelope = buildUpdateEnvelope(processFixture(), { changeDescription: 'x' });
  assert.equal(envelope.SuppressChangeNotification, true);

  const loud = buildUpdateEnvelope(processFixture(), {
    changeDescription: 'x',
    suppressChangeNotification: false,
  });
  assert.equal(loud.SuppressChangeNotification, false);
});

test('the envelope defaults to neither publishing nor submitting', () => {
  const envelope = buildUpdateEnvelope(processFixture(), { changeDescription: 'x' });
  assert.equal(envelope.DoPublish, false);
  assert.equal(envelope.DoSubmitForApproval, false);
  assert.deepEqual(envelope.SharedActivityCollectionEditModel, {
    ActivitiesToDelete: [],
    ActivitiesToShare: [],
    ActivitiesToUnlink: [],
  });
  assert.deepEqual(envelope.VariantConnectionChangeStates, []);
});

test('updateProcess accepts a 204 with no body', async () => {
  const h = harness([undefined]);
  const envelope = buildUpdateEnvelope(processFixture(), { changeDescription: 'Updated Shortcut.' });
  await updateProcess(h.ctx, '38c70a88-18a6-4b94-8ed7-c6fa0820852a', envelope);
  assert.equal(h.calls[0]!.method, 'PUT');
  assert.equal(JSON.parse(h.calls[0]!.body!).ChangeDescription, 'Updated Shortcut.');
});

test('publishProcess sends the revision id as a string', async () => {
  // processJson carries it as a number; this endpoint wants a string.
  const h = harness([{ actionUrl: '/tenant/Process/38c70a88' }]);
  await publishProcess(h.ctx, '38c70a88-18a6-4b94-8ed7-c6fa0820852a', 9182);
  assert.equal(h.calls[0]!.body, '{"ProcessRevisionEditId":"9182","IsPublishNow":true}');
});

test('getLatestRevision reads the cheap concurrency check', async () => {
  const h = harness([{ latestProcessRevisionEditId: 9174 }]);
  const result = await getLatestRevision(h.ctx, '38c70a88-18a6-4b94-8ed7-c6fa0820852a');
  assert.equal(result.latestProcessRevisionEditId, 9174);
  assert.match(h.calls[0]!.url, /\/bff\/Process\/api\/v1\/processes\/38c70a88.*\/revisions\/latest$/);
});

test('withShortcuts replaces the list without mutating the original', () => {
  const original = processFixture();
  const updated = withShortcuts(original, [
    { Id: 770, UniqueId: '3f240d01-5dac-437d-8825-b48feda09bab', Name: 'My Group' },
    { Id: 222, UniqueId: '3c42fbb0-8e23-4122-9aac-fe8b0aa58e3b', Name: 'YourCompany Limited' },
  ]);

  assert.equal(updated.ProcessGroupItems.ProcessGroupShortcut?.length, 2);
  // The original must stay intact so the caller can still diff against it.
  assert.equal(original.ProcessGroupItems.ProcessGroupShortcut, null);
  // The home group is untouched — we only ever replace shortcuts.
  assert.equal(updated.ProcessGroupItems.ProcessGroup.UniqueId, original.ProcessGroupItems.ProcessGroup.UniqueId);
});

test('withShortcuts writes an empty array for a clear, not null', () => {
  const updated = withShortcuts(processFixture(), []);
  assert.deepEqual(updated.ProcessGroupItems.ProcessGroupShortcut, []);
});

test('unrelated process fields survive a shortcut edit', () => {
  // We PUT the whole document back, so anything dropped here is data loss.
  const updated = withShortcuts(processFixture(), []);
  assert.equal(updated.Objective, 'Test');
  assert.equal(updated.ProcessRevisionEditId, 9180);
  assert.equal(updated.Version, '2.0');
});

test('currentShortcuts treats null and empty alike', () => {
  assert.deepEqual(currentShortcuts(processFixture()), []);

  const withTwo = withShortcuts(processFixture(), [
    { Id: 770, UniqueId: 'a', Name: 'A' },
    { Id: 222, UniqueId: 'b', Name: 'B' },
  ]);
  assert.deepEqual(currentShortcuts(withTwo).map((s) => s.UniqueId), ['a', 'b']);
});
