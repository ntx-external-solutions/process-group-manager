import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShortcutCsv } from '../csv/shortcuts.ts';
import type {
  ProcessActions,
  ProcessGroupRef,
  ProcessRevisionStateId,
} from '../pm/types.ts';
import {
  isNoOp,
  planShortcuts,
  publishCount,
  writeCount,
  type ProcessSnapshot,
  type ResolvedGroup,
  type ShortcutPlanDeps,
} from './shortcutPlan.ts';

const UUID = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';
const LEGAL = '3f240d01-1c4a-4a3e-9d3a-2b0f5a6c8d90';
const FINANCE = '3c42fbb0-7e21-4a55-9a1f-6b7c8d9e0f11';
const UNKNOWN = 'deadbeef-0000-0000-0000-000000000000';

let nextGroupId = 1;

/** A shortcut as Process Manager reports it: id, uniqueId, and leaf name. */
function sc(uniqueId: string, name: string): ProcessGroupRef {
  return { Id: nextGroupId++, UniqueId: uniqueId, Name: name };
}

function actions(over: Partial<ProcessActions> = {}): ProcessActions {
  return {
    CanPublish: false,
    CanPublishAfterEdit: true,
    CanSubmitForApproval: false,
    CanSubmitForApprovalAfterEdit: true,
    CanQuickSave: true,
    CanSave: true,
    CanPublishWithoutComment: true,
    CanSuppressPublishChangeNotification: true,
    ...over,
  };
}

function snapshot(over: Partial<ProcessSnapshot> = {}): ProcessSnapshot {
  return {
    uniqueId: UUID,
    name: '(draft) PQL via BDR',
    version: '2.0',
    revisionEditId: 9180,
    revisionStateId: 3 as ProcessRevisionStateId,
    currentShortcuts: [],
    actions: actions(),
    canEdit: true,
    ...over,
  };
}

const GROUPS: Record<string, ResolvedGroup> = {
  [LEGAL]: { uniqueId: LEGAL, id: 501, name: 'Compliance', display: 'Legal | Compliance' },
  [FINANCE]: { uniqueId: FINANCE, id: 502, name: 'Finance', display: 'Finance & IT | Finance' },
};

function deps(over: Partial<ShortcutPlanDeps> = {}): ShortcutPlanDeps {
  return {
    resolveGroup: (uniqueId) => GROUPS[uniqueId.toLowerCase()] ?? null,
    resolveProcess: () => ({ kind: 'found', snapshot: snapshot() }),
    ...over,
  };
}

/** Build the parsed rows a test needs, failing loudly on a bad fixture. */
function rows(body: string, header = 'Process Unique Id,Group Unique Id,Action') {
  const parsed = parseShortcutCsv(`${header}\n${body}`);
  assert.deepEqual(parsed.errors, [], 'fixture CSV should parse cleanly');
  return parsed.processes;
}

/** Shorthand for the common case: one process, one Add. */
const addLegal = (): ReturnType<typeof rows> => rows(`${UUID},${LEGAL},Add`);

test('an Add row becomes an update', () => {
  const plan = planShortcuts(
    rows(`${UUID},${LEGAL},Add\n${UUID},${FINANCE},Add`),
    deps(),
  );
  assert.equal(plan.updates.length, 1, 'one process, however many rows');
  assert.deepEqual(plan.updates[0]?.desired.map((g) => g.uniqueId), [LEGAL, FINANCE]);
  assert.deepEqual(plan.updates[0]?.lines, [2, 3]);
});

test('adding keeps the shortcuts the file does not mention', () => {
  // The whole point of additive semantics: a partial file cannot strip anything.
  const plan = planShortcuts(addLegal(), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc(FINANCE, 'Finance')] }),
    }),
  });
  assert.deepEqual(plan.updates[0]?.desired.map((g) => g.uniqueId), [FINANCE, LEGAL]);
});

test('a row naming no group changes nothing and is not blocked', () => {
  // It must not consult permissions or state: there is nothing to permit.
  const plan = planShortcuts(rows(`${UUID},,`), {
    resolveGroup: () => null,
    resolveProcess: () => {
      throw new Error('a row with no group must not resolve the process');
    },
  });
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.unchanged[0]?.reason, 'no-data');
  assert.equal(isNoOp(plan), true);
});

test('adding a shortcut the process already has writes nothing', () => {
  // The property that keeps a re-run from republishing 1,518 processes.
  const plan = planShortcuts(addLegal(), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc(LEGAL, 'Compliance')] }),
    }),
  });
  assert.equal(isNoOp(plan), true);
  assert.equal(plan.unchanged[0]?.reason, 'already-matches');
});

test('ids compare case-insensitively against what the tenant reports', () => {
  const plan = planShortcuts(addLegal(), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc(LEGAL.toUpperCase(), 'Compliance')] }),
    }),
  });
  assert.equal(isNoOp(plan), true);
});

test('Remove takes one shortcut away and leaves the rest', () => {
  const plan = planShortcuts(rows(`${UUID},${LEGAL},Remove`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({
        currentShortcuts: [sc(LEGAL, 'Compliance'), sc(FINANCE, 'Finance')],
      }),
    }),
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.clears.length, 0);
  assert.deepEqual(plan.updates[0]?.desired.map((g) => g.uniqueId), [FINANCE]);
});

test('removing the last shortcut is a clear, kept separate from updates', () => {
  const plan = planShortcuts(rows(`${UUID},${LEGAL},Remove`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc(LEGAL, 'Compliance')] }),
    }),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.clears.length, 1);
  assert.deepEqual(plan.clears[0]?.desired, []);
});

test('removing a shortcut the process does not have warns instead of failing', () => {
  const plan = planShortcuts(rows(`${UUID},${LEGAL},Remove`), deps());
  assert.equal(isNoOp(plan), true);
  assert.equal(plan.unchanged[0]?.reason, 'already-matches');
  assert.match(plan.warnings[0]!.message, /nothing to remove/);
});

test('CLEAR on a process with shortcuts is a clear', () => {
  const plan = planShortcuts(rows(`${UUID},CLEAR,`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc(LEGAL, 'Compliance')] }),
    }),
  });
  assert.equal(plan.clears.length, 1);
  assert.deepEqual(plan.clears[0]?.desired, []);
});

test('CLEAR on a process with no shortcuts is already-matching', () => {
  const plan = planShortcuts(rows(`${UUID},CLEAR,`), deps());
  assert.equal(plan.clears.length, 0);
  assert.equal(plan.unchanged[0]?.reason, 'already-matches');
});

test('CLEAR plus Add replaces the whole set', () => {
  const plan = planShortcuts(rows(`${UUID},CLEAR,\n${UUID},${LEGAL},Add`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc(FINANCE, 'Finance')] }),
    }),
  });
  assert.deepEqual(plan.updates[0]?.desired.map((g) => g.uniqueId), [LEGAL]);
});

test('an unknown group id blocks the process rather than dropping the shortcut', () => {
  const plan = planShortcuts(rows(`${UUID},${UNKNOWN},Add`), deps());
  assert.equal(plan.updates.length, 0);
  assert.match(plan.blocked[0]!.reason, /was not found in your tenant/);
});

test('a shortcut into a group we cannot see is kept, not silently dropped', () => {
  // Permissions can hide a group from the tree. Rewriting the process without that
  // shortcut would remove it, which is not what the file asked for.
  const hidden = sc('11111111-1111-1111-1111-111111111111', 'Hidden');
  const plan = planShortcuts(addLegal(), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [hidden] }),
    }),
  });
  assert.deepEqual(plan.updates[0]?.desired.map((g) => g.uniqueId), [hidden.UniqueId, LEGAL]);
});

test('a process the file names but the tenant does not have is blocked', () => {
  const plan = planShortcuts(addLegal(), {
    ...deps(),
    resolveProcess: () => ({ kind: 'missing' }),
  });
  assert.match(plan.blocked[0]!.reason, /No matching process/);
});

test('a renamed process warns but still applies', () => {
  const plan = planShortcuts(
    rows(`${UUID},Old Name,${LEGAL},Add`, 'Process Unique Id,Process Name,Group Unique Id,Action'),
    deps(),
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0]!.message, /now named/);
});

// ------------------------------------------------------- write path

test('an in-progress process saves without publishing, whatever the choice', () => {
  for (const publish of ['save-only', 'match-state'] as const) {
    const plan = planShortcuts(
      addLegal(),
      {
        ...deps(),
        resolveProcess: () => ({
          kind: 'found',
          snapshot: snapshot({ revisionStateId: 1, version: '0.3' }),
        }),
      },
      { publish },
    );
    assert.deepEqual(plan.updates[0]?.writePath, { kind: 'save-only' }, publish);
    assert.equal(plan.updates[0]?.fromPublished, false);
  }
});

test('a published process is saved as a draft when that is the choice', () => {
  const plan = planShortcuts(addLegal(), deps(), { publish: 'save-only' });
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'save-only' });
  assert.equal(plan.updates[0]?.fromPublished, true);
  assert.equal(publishCount(plan), 0);
});

test('saving is the default, so nothing publishes unless it was asked for', () => {
  const plan = planShortcuts(addLegal(), deps());
  assert.equal(publishCount(plan), 0);
  assert.equal(plan.publish, 'save-only');
});

test('match-state cannot publish a process that is already in progress', () => {
  // The reported bug: picking match-state on a 2.1 process and watching it merely save.
  // That is correct — there is no published version to replace, and the pending draft
  // may hold edits that are not ours — but it has to be visible rather than surprising.
  const plan = planShortcuts(
    addLegal(),
    {
      ...deps(),
      resolveProcess: () => ({
        kind: 'found',
        snapshot: snapshot({ revisionStateId: 1, version: '2.1' }),
      }),
    },
    { publish: 'match-state' },
  );

  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'save-only' });
  assert.equal(plan.updates[0]?.fromPublished, false, 'not published, so no draft is left behind');
  assert.equal(publishCount(plan), 0);
});

test('a published process publishes directly when permitted and asked for', () => {
  const plan = planShortcuts(addLegal(), deps(), { publish: 'match-state' });
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'publish-direct' });
  assert.equal(publishCount(plan), 1);
});

test('a published process falls back to the submit-then-publish route', () => {
  // Exactly the case observed in the capture: CanPublishAfterEdit false,
  // CanSubmitForApprovalAfterEdit true.
  const plan = planShortcuts(
    addLegal(),
    {
      ...deps(),
      resolveProcess: () => ({
        kind: 'found',
        snapshot: snapshot({
          actions: actions({ CanPublishAfterEdit: false, CanSubmitForApprovalAfterEdit: true }),
        }),
      }),
    },
    { publish: 'match-state' },
  );
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'submit-then-publish' });
});

test('a process awaiting approval is skipped with a stated reason', () => {
  const plan = planShortcuts(addLegal(), {
    ...deps(),
    resolveProcess: () => ({ kind: 'found', snapshot: snapshot({ revisionStateId: 2 }) }),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0]!.reason, /Awaiting approval/);
});

test('a process the user cannot edit is blocked', () => {
  const plan = planShortcuts(addLegal(), {
    ...deps(),
    resolveProcess: () => ({ kind: 'found', snapshot: snapshot({ canEdit: false }) }),
  });
  assert.match(plan.blocked[0]!.reason, /permission to edit/);
});

test('a published process with no publish rights is blocked only when republishing', () => {
  // Writing it would silently queue for approval and look like success. Saving it as a
  // draft asks for none of that, so the same process is perfectly writable.
  const cannotPublish = {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found' as const,
      snapshot: snapshot({
        actions: actions({
          CanPublishAfterEdit: false,
          CanSubmitForApprovalAfterEdit: false,
        }),
      }),
    }),
  };

  const republish = planShortcuts(addLegal(), cannotPublish, { publish: 'match-state' });
  assert.equal(republish.updates.length, 0);
  assert.match(republish.blocked[0]!.reason, /neither publish it nor submit/);

  const save = planShortcuts(addLegal(), cannotPublish, { publish: 'save-only' });
  assert.equal(save.updates.length, 1);
  assert.equal(save.blocked.length, 0);
});

test('writeCount reflects the cost of each route', () => {
  const submitThenPublish = {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found' as const,
      snapshot: snapshot({
        actions: actions({ CanPublishAfterEdit: false, CanSubmitForApprovalAfterEdit: true }),
      }),
    }),
  };

  // save + submit + publish
  assert.equal(writeCount(planShortcuts(addLegal(), submitThenPublish, { publish: 'match-state' })), 3);
  // save only
  assert.equal(writeCount(planShortcuts(addLegal(), submitThenPublish, { publish: 'save-only' })), 1);
});
