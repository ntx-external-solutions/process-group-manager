import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../csv/parse.ts';
import type { GroupPlan } from '../plan/groupPlan.ts';
import type { ResolvedGroup, ShortcutChange, ShortcutPlan } from '../plan/shortcutPlan.ts';
import type { ProcessGroupRef } from '../pm/types.ts';
import {
  buildGroupPreview,
  buildShortcutPreview,
  describeCreateParent,
  describeWritePath,
  diffShortcuts,
  expectedVersion,
  groupPreviewToCsv,
  requiresClearConfirmation,
  shortcutPreviewToCsv,
} from './preview.ts';

const LEGAL: ProcessGroupRef = { Id: 1, UniqueId: 'grp-legal', Name: 'Compliance' };
const FINANCE: ProcessGroupRef = { Id: 2, UniqueId: 'grp-finance', Name: 'Finance' };

function existing(uniqueId: string, display: string): ResolvedGroup {
  return { uniqueId, id: 900, name: display.split(' | ').pop() as string, display };
}

function change(over: Partial<ShortcutChange> = {}): ShortcutChange {
  return {
    line: 2,
    lines: [2],
    processUniqueId: '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c',
    processName: 'PQL via BDR',
    version: '2.0',
    revisionEditId: 9180,
    desired: [],
    currentShortcuts: [],
    writePath: { kind: 'publish-direct' },
    fromPublished: true,
    ...over,
  };
}

function shortcutPlan(over: Partial<ShortcutPlan> = {}): ShortcutPlan {
  return {
    updates: [],
    clears: [],
    unchanged: [],
    blocked: [],
    warnings: [],
    publish: 'match-state',
    ...over,
  };
}

// ----------------------------------------------------------------- diff

test('an added shortcut is named by its full path, not its id', () => {
  // The id is what the file carries and what nobody can read. The preview has to say
  // which group it landed on, or there is nothing to check.
  const diff = diffShortcuts([], [existing('grp-legal', 'Legal | Compliance')]);
  assert.deepEqual(diff.added, ['Legal | Compliance']);
  assert.deepEqual(diff.removed, []);
});

test('a removed shortcut is named, not counted', () => {
  // "Removing 2 shortcuts" is not something anyone can approve.
  const diff = diffShortcuts([LEGAL, FINANCE], []);
  assert.deepEqual(diff.removed, ['Compliance', 'Finance']);
});

test('a shortcut present before and after is kept, not re-added', () => {
  const diff = diffShortcuts(
    [LEGAL, FINANCE],
    [existing('grp-legal', 'Legal | Compliance'), existing('grp-new', 'New | Place')],
  );
  assert.deepEqual(diff.kept, ['Legal | Compliance']);
  assert.deepEqual(diff.added, ['New | Place']);
  assert.deepEqual(diff.removed, ['Finance']);
});

test('ids compare case-insensitively, so nothing is re-added to itself', () => {
  const diff = diffShortcuts([LEGAL], [existing(LEGAL.UniqueId.toUpperCase(), 'Legal | Compliance')]);
  assert.deepEqual(diff.kept, ['Legal | Compliance']);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
});

// -------------------------------------------------------------- versions

test('a published process is expected to gain a major version', () => {
  assert.equal(expectedVersion('2.3', { kind: 'publish-direct' }), '3.0');
  assert.equal(expectedVersion('2.3', { kind: 'submit-then-publish' }), '3.0');
});

test('an in-progress process is expected to gain a minor version', () => {
  assert.equal(expectedVersion('2.3', { kind: 'save-only' }), '2.4');
});

test('an unrecognised version predicts nothing rather than guessing', () => {
  assert.equal(expectedVersion('', { kind: 'save-only' }), null);
  assert.equal(expectedVersion('draft', { kind: 'publish-direct' }), null);
  assert.equal(expectedVersion('1.2.3', { kind: 'publish-direct' }), null);
});

// --------------------------------------------------------- shortcut view

test('clears are separated from updates and force a second confirmation', () => {
  const preview = buildShortcutPreview(
    shortcutPlan({
      updates: [change({ line: 2, desired: [existing('grp-legal', 'Legal | Compliance')] })],
      clears: [change({ line: 3, currentShortcuts: [LEGAL] })],
    }),
  );

  assert.equal(preview.updates.length, 1);
  assert.equal(preview.clears.length, 1);
  assert.equal(requiresClearConfirmation(preview), true);
  assert.deepEqual(preview.clears[0]?.diff.removed, ['Compliance']);
});

test('a plan with no clears needs no second confirmation', () => {
  const preview = buildShortcutPreview(shortcutPlan({ updates: [change()] }));
  assert.equal(requiresClearConfirmation(preview), false);
});

test('the publish count is separated from the draft count', () => {
  // The number of processes that will get a new *published* version is the one that
  // decides whether this run is safe to start.
  const preview = buildShortcutPreview(
    shortcutPlan({
      updates: [
        change({ line: 2, writePath: { kind: 'publish-direct' } }),
        change({ line: 3, writePath: { kind: 'submit-then-publish' } }),
        change({ line: 4, writePath: { kind: 'save-only' } }),
      ],
    }),
  );

  assert.equal(preview.counts.publishes, 2);
  assert.equal(preview.counts.drafts, 1);
  // 2 + 3 + 1 requests.
  assert.equal(preview.writes, 6);
});

test('a draft left on a published process is counted on its own', () => {
  // "Saved as a draft" hides the surprise: the live version still has the old
  // shortcuts. That case needs its own number, not a share of the draft count.
  const preview = buildShortcutPreview(
    shortcutPlan({
      publish: 'save-only',
      updates: [
        change({ line: 2, writePath: { kind: 'save-only' }, fromPublished: true }),
        change({ line: 3, writePath: { kind: 'save-only' }, fromPublished: false }),
      ],
    }),
  );

  assert.equal(preview.counts.publishes, 0);
  assert.equal(preview.counts.drafts, 2);
  assert.equal(preview.counts.draftsOnPublished, 1);
  assert.equal(preview.counts.inProgress, 1);
  assert.equal(preview.publish, 'save-only');
});

test('processes already in progress are counted, whatever the choice', () => {
  // The number that answers "why did picking match-state publish nothing?". Without it
  // the only evidence is the run report, after the fact.
  const preview = buildShortcutPreview(
    shortcutPlan({
      publish: 'match-state',
      updates: [
        change({ line: 2, writePath: { kind: 'publish-direct' }, fromPublished: true }),
        change({ line: 3, writePath: { kind: 'save-only' }, fromPublished: false }),
        change({ line: 4, writePath: { kind: 'save-only' }, fromPublished: false }),
      ],
    }),
  );

  assert.equal(preview.counts.publishes, 1);
  assert.equal(preview.counts.inProgress, 2);
  assert.equal(preview.counts.draftsOnPublished, 0, 'match-state leaves no draft on a live process');
});

test('the effect of a save says whether a published version is left behind', () => {
  assert.equal(
    describeWritePath({ kind: 'save-only' }, true),
    'Saves a draft. The published version keeps its current shortcuts.',
  );
  // The wording that was missing when "republish" appeared to do nothing: an
  // in-progress process is saved under either choice, and the row says why.
  assert.equal(
    describeWritePath({ kind: 'save-only' }, false),
    'Already in progress, so it is saved. Nothing to republish.',
  );
  assert.match(describeWritePath({ kind: 'publish-direct' }), /new major version/);
});

test('rows are ordered by CSV line so they follow the spreadsheet', () => {
  const preview = buildShortcutPreview(
    shortcutPlan({ updates: [change({ line: 9 }), change({ line: 2 }), change({ line: 5 })] }),
  );
  assert.deepEqual(preview.updates.map((r) => r.line), [2, 5, 9]);
});

test('a plan that writes nothing says so', () => {
  const preview = buildShortcutPreview(
    shortcutPlan({
      unchanged: [{ line: 2, processUniqueId: 'x', processName: 'y', reason: 'already-matches' }],
    }),
  );
  assert.equal(preview.isNoOp, true);
  assert.equal(preview.counts.unchanged, 1);
});

test('blocked rows survive into the preview with their reason', () => {
  const preview = buildShortcutPreview(
    shortcutPlan({
      blocked: [
        {
          line: 4,
          processUniqueId: 'x',
          processName: 'Awaiting one',
          reason: 'Awaiting approval, so it was not modified.',
        },
      ],
    }),
  );
  assert.equal(preview.counts.blocked, 1);
  assert.match(preview.blocked[0]?.reason as string, /Awaiting approval/);
});

// ------------------------------------------------------------ group view

test('a top-level group says so rather than showing an empty parent', () => {
  assert.equal(describeCreateParent({ kind: 'root' }), 'at the top level');
  assert.equal(
    describeCreateParent({ kind: 'existing', uniqueId: 'g', display: 'Top' }),
    'inside Top',
  );
  assert.equal(
    describeCreateParent({ kind: 'planned', seq: 0, display: 'Top' }),
    'inside Top (also new)',
  );
});

test('the group preview counts existing paths without listing them', () => {
  const plan: GroupPlan = {
    renames: [],
    moves: [],
    creates: [
      {
        seq: 0,
        path: ['Top', 'New'],
        display: 'Top | New',
        name: 'New',
        parent: { kind: 'existing', uniqueId: 'g-top', display: 'Top' },
        line: 3,
      },
    ],
    existing: [{ path: ['Top'], display: 'Top', uniqueId: 'g-top', line: 2 }],
    blocked: [],
  };

  const preview = buildGroupPreview(plan);
  assert.equal(preview.creates.length, 1);
  assert.equal(preview.creates[0]?.parentLabel, 'inside Top');
  assert.equal(preview.existingCount, 1);
  assert.equal(preview.isNoOp, false);
});

// ------------------------------------------------------------------ csv

test('the shortcut plan downloads as a reviewable CSV', () => {
  // 1,518 rows cannot be reviewed on screen; the CSV is the real review surface.
  const preview = buildShortcutPreview(
    shortcutPlan({
      updates: [
        change({
          line: 2,
          lines: [2, 7],
          currentShortcuts: [FINANCE],
          desired: [existing('grp-legal', 'Legal | Compliance'), existing('grp-new', 'Brand | New')],
        }),
      ],
      clears: [change({ line: 3, currentShortcuts: [LEGAL] })],
    }),
  );

  const grid = parseCsv(shortcutPreviewToCsv(preview));
  assert.deepEqual(grid[0]?.slice(0, 3), ['Action', 'Process Unique Id', 'Process Name']);

  const update = grid[1] as string[];
  assert.equal(update[0], 'Update');
  assert.equal(update[4], '3.0');
  assert.equal(update[5], 'Legal | Compliance; Brand | New');
  assert.equal(update[6], 'Finance');
  // Every row that fed the change, because a process gathers shortcuts from several.
  assert.equal(update[9], '2, 7');

  assert.equal((grid[2] as string[])[0], 'Clear');
});

test('the group plan downloads as a reviewable CSV', () => {
  const preview = buildGroupPreview({
    renames: [],
    moves: [],
    creates: [
      {
        seq: 0,
        path: ['Top'],
        display: 'Top',
        name: 'Top',
        parent: { kind: 'root' },
        line: 2,
      },
    ],
    existing: [
      { path: ['Finance'], display: 'Finance', uniqueId: 'aaaaaaaa-1111-2222-3333-444444444444', line: 3 },
    ],
    blocked: [{ line: 5, display: 'Bad | Path', message: 'Matches 2 existing groups.' }],
  });

  const grid = parseCsv(groupPreviewToCsv(preview));
  assert.deepEqual(grid[1], ['Create', 'Top', '', 'at the top level', '2']);
  // The id a matched row resolved to is the point of the column: it is how someone
  // checks that a path pointed at the group they meant.
  assert.deepEqual(grid[2], [
    'Already exists',
    'Finance',
    'aaaaaaaa-1111-2222-3333-444444444444',
    '',
    '3',
  ]);
  assert.deepEqual(grid[3], ['Blocked', 'Bad | Path', '', 'Matches 2 existing groups.', '5']);
});
