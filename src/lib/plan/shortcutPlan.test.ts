import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShortcutCsv } from '../csv/shortcuts.ts';
import { pathKey } from '../csv/path.ts';
import type {
  ProcessActions,
  ProcessGroupRef,
  ProcessRevisionStateId,
} from '../pm/types.ts';
import {
  isNoOp,
  planShortcuts,
  writeCount,
  type ProcessSnapshot,
  type ResolvedGroup,
  type ShortcutPlanDeps,
} from './shortcutPlan.ts';

const UUID = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';
const LEGAL = 'grp-legal';
const FINANCE = 'grp-finance';

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
  [pathKey(['Legal', 'Compliance'])]: {
    uniqueId: LEGAL,
    plannedSeq: null,
    name: 'Compliance',
    display: 'Legal | Compliance',
  },
  [pathKey(['Finance & IT', 'Finance'])]: {
    uniqueId: FINANCE,
    plannedSeq: null,
    name: 'Finance',
    display: 'Finance & IT | Finance',
  },
};

function deps(over: Partial<ShortcutPlanDeps> = {}): ShortcutPlanDeps {
  return {
    resolveGroup: (key) => GROUPS[key] ?? null,
    resolveProcess: () => ({ kind: 'found', snapshot: snapshot() }),
    ...over,
  };
}

function rows(csv: string) {
  const parsed = parseShortcutCsv(csv);
  assert.deepEqual(parsed.errors, [], 'fixture CSV should parse cleanly');
  return parsed.rows;
}

test('a populated row becomes an update', () => {
  const plan = planShortcuts(
    rows(`Process ID,Shortcut 1,Shortcut 2\n${UUID},Legal | Compliance,Finance & IT | Finance`),
    deps(),
  );
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0]?.desired.map((g) => g.uniqueId), [LEGAL, FINANCE]);
});

test('a blank row changes nothing and is not blocked', () => {
  // Blank means "I did not say", so it must not consult permissions or state.
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},`), {
    resolveGroup: () => null,
    resolveProcess: () => {
      throw new Error('a blank row must not resolve the process');
    },
  });
  assert.equal(plan.unchanged.length, 1);
  assert.equal(plan.unchanged[0]?.reason, 'no-data');
  assert.equal(isNoOp(plan), true);
});

test('CLEAR on a process with shortcuts is a clear, kept separate from updates', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},CLEAR`), {
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

test('CLEAR on a process with no shortcuts is already-matching', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},CLEAR`), deps());
  assert.equal(plan.clears.length, 0);
  assert.equal(plan.unchanged[0]?.reason, 'already-matches');
});

test('re-applying the same shortcuts writes nothing', () => {
  // The property that keeps a re-run from republishing 1,518 processes.
  const plan = planShortcuts(
    rows(`Process ID,Shortcut 1,Shortcut 2\n${UUID},Legal | Compliance,Finance & IT | Finance`),
    {
      ...deps(),
      resolveProcess: () => ({
        kind: 'found',
        snapshot: snapshot({ currentShortcuts: [sc(FINANCE, 'Finance'), sc(LEGAL, 'Compliance')] }),
      }),
    },
  );
  assert.equal(isNoOp(plan), true);
  assert.equal(plan.unchanged[0]?.reason, 'already-matches');
});

test('order of existing shortcuts does not count as a difference', () => {
  const plan = planShortcuts(
    rows(`Process ID,Shortcut 1,Shortcut 2\n${UUID},Finance & IT | Finance,Legal | Compliance`),
    {
      ...deps(),
      resolveProcess: () => ({
        kind: 'found',
        snapshot: snapshot({ currentShortcuts: [sc(LEGAL, 'Compliance'), sc(FINANCE, 'Finance')] }),
      }),
    },
  );
  assert.equal(isNoOp(plan), true);
});

test('dropping one of two shortcuts is an update, not a clear', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc(LEGAL, 'Compliance'), sc(FINANCE, 'Finance')] }),
    }),
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.clears.length, 0);
});

test('an in-progress process saves without publishing', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ revisionStateId: 1, version: '0.3' }),
    }),
  });
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'save-only' });
});

test('a published process publishes directly when permitted', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), deps());
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'publish-direct' });
});

test('a published process falls back to the submit-then-publish route', () => {
  // Exactly the case observed in the capture: CanPublishAfterEdit false,
  // CanSubmitForApprovalAfterEdit true.
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({
        actions: actions({ CanPublishAfterEdit: false, CanSubmitForApprovalAfterEdit: true }),
      }),
    }),
  });
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'submit-then-publish' });
});

test('a process awaiting approval is skipped with a stated reason', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ revisionStateId: 2 }),
    }),
  });
  assert.equal(plan.updates.length, 0);
  assert.equal(plan.blocked.length, 1);
  assert.match(plan.blocked[0]!.reason, /Awaiting approval/);
});

test('a process the user cannot edit is blocked', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), {
    ...deps(),
    resolveProcess: () => ({ kind: 'found', snapshot: snapshot({ canEdit: false }) }),
  });
  assert.match(plan.blocked[0]!.reason, /permission to edit/);
});

test('a published process with neither publish nor approval rights is blocked', () => {
  // Writing it would silently queue for approval and look like success.
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({
        actions: actions({
          CanPublishAfterEdit: false,
          CanSubmitForApprovalAfterEdit: false,
        }),
      }),
    }),
  });
  assert.equal(plan.updates.length, 0);
  assert.match(plan.blocked[0]!.reason, /neither publish nor submit/);
});

test('an unknown shortcut group blocks the row rather than dropping the shortcut', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Nowhere | Missing`), deps());
  assert.equal(plan.updates.length, 0);
  assert.match(plan.blocked[0]!.reason, /does not exist/);
});

test('a group created earlier in the same run is a valid target', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Brand | New`), {
    ...deps(),
    resolveGroup: () => ({
      uniqueId: null,
      plannedSeq: 4,
      name: 'New',
      display: 'Brand | New',
    }),
  });
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]?.desired[0]?.plannedSeq, 4);
});

test('a not-yet-created group never counts as already-matching', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Brand | New`), {
    ...deps(),
    resolveGroup: () => ({ uniqueId: null, plannedSeq: 0, name: 'New', display: 'Brand | New' }),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({ currentShortcuts: [sc('something', 'Something')] }),
    }),
  });
  assert.equal(plan.updates.length, 1);
});

test('an ambiguous process name is blocked with a count', () => {
  const plan = planShortcuts(
    rows('Process Name,Shortcut 1\nMonthly Report,Legal | Compliance'),
    {
      ...deps(),
      resolveProcess: () => ({ kind: 'ambiguous', candidates: ['a', 'b', 'c'] }),
    },
  );
  assert.match(plan.blocked[0]!.reason, /matches 3 processes/);
});

test('a renamed process warns but still applies', () => {
  const plan = planShortcuts(
    rows(`Process ID,Process Name,Shortcut 1\n${UUID},Old Name,Legal | Compliance`),
    deps(),
  );
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0]!.message, /now named/);
});

test('writeCount reflects the cost of each route', () => {
  const plan = planShortcuts(rows(`Process ID,Shortcut 1\n${UUID},Legal | Compliance`), {
    ...deps(),
    resolveProcess: () => ({
      kind: 'found',
      snapshot: snapshot({
        actions: actions({ CanPublishAfterEdit: false, CanSubmitForApprovalAfterEdit: true }),
      }),
    }),
  });
  // save + submit + publish
  assert.equal(writeCount(plan), 3);
});
