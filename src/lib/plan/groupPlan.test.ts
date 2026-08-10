import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupCsv } from '../csv/groups.ts';
import type { TreeItem, TreeItemType } from '../pm/types.ts';
import { addLevel, emptyTree, type GroupTree } from './tree.ts';
import { GROUP_ID_HEADER } from '../csv/layout.ts';
import { isNoOp, planGroups } from './groupPlan.ts';

let nextId = 1000;
function item(title: string, itemType: TreeItemType = 'group'): TreeItem {
  nextId += 1;
  return {
    id: nextId,
    uniqueId: `uid-${nextId}`,
    title,
    itemType,
    itemOrder: 0,
    hasChild: false,
    totalSubgroups: 0,
    totalStakeholderUsers: 0,
    totalPermissionRoles: 1,
    totalPermissionUsers: 0,
    variationSetId: null,
  };
}

/** Build a tree whose every level is marked loaded. */
function tree(
  roots: TreeItem[],
  levels: Record<string, TreeItem[]> = {},
): GroupTree {
  const t = addLevel(emptyTree(), null, roots);
  // Mark every root as loaded, using the supplied children where given.
  for (const r of roots) addLevel(t, r.uniqueId, levels[r.uniqueId] ?? []);
  for (const [parent, kids] of Object.entries(levels)) {
    if (roots.some((r) => r.uniqueId === parent)) continue;
    addLevel(t, parent, kids);
  }
  return t;
}

function plan(t: GroupTree, csv: string) {
  const parsed = parseGroupCsv(csv);
  assert.deepEqual(parsed.errors, [], 'fixture CSV should parse cleanly');
  const outcome = planGroups(t, parsed.rows);
  assert.equal(outcome.status, 'ok', 'fixture tree should be fully loaded');
  assert.ok(outcome.status === 'ok');
  return outcome.plan;
}

test('creates a whole new branch, parents before children', () => {
  const p = plan(
    tree([]),
    'Top Group\nTop Group | Secondary Group | Lower Level Group 1',
  );

  assert.deepEqual(
    p.creates.map((c) => c.display),
    ['Top Group', 'Top Group | Secondary Group', 'Top Group | Secondary Group | Lower Level Group 1'],
  );

  // The intermediate group was never listed in the CSV but is implied by the leaf.
  assert.equal(p.creates[1]?.parent.kind, 'planned');
  assert.equal(p.creates[2]?.parent.kind, 'planned');
  assert.equal(p.creates[0]?.parent.kind, 'root');
});

test('a create references its parent by plan sequence, not by a guessed id', () => {
  const p = plan(tree([]), 'A | B | C');
  const b = p.creates[1]!;
  const c = p.creates[2]!;
  assert.deepEqual(b.parent, { kind: 'planned', seq: 0, display: 'A' });
  assert.deepEqual(c.parent, { kind: 'planned', seq: 1, display: 'A | B' });
});

test('an existing group is matched, not recreated', () => {
  const top = item('Top Group');
  const p = plan(tree([top]), 'Top Group');
  assert.deepEqual(p.creates, []);
  assert.equal(p.existing.length, 1);
  assert.equal(p.existing[0]?.uniqueId, top.uniqueId);
});

test('a trailing-space group in the tenant is matched, not duplicated', () => {
  // "Partner Facing " is real production data.
  const portal = item('Partner Portal');
  const facing = item('Partner Facing ');
  const p = plan(
    tree([portal], { [portal.uniqueId]: [facing] }),
    'Partner Portal | Partner Facing',
  );
  assert.deepEqual(p.creates, [], 'must not create a second "Partner Facing"');
  assert.equal(p.existing.at(-1)?.uniqueId, facing.uniqueId);
});

test('new children attach to an existing parent by uniqueId', () => {
  const top = item('Top Group');
  const p = plan(tree([top]), 'Top Group | Brand New');
  assert.equal(p.creates.length, 1);
  assert.deepEqual(p.creates[0]?.parent, {
    kind: 'existing',
    uniqueId: top.uniqueId,
    display: 'Top Group',
  });
});

test('the created name keeps the author spelling, not the match key', () => {
  const p = plan(tree([]), 'Go To Market (Sales and Marketing)');
  assert.equal(p.creates[0]?.name, 'Go To Market (Sales and Marketing)');
});

test('re-running an applied file is a no-op', () => {
  const top = item('Top Group');
  const secondary = item('Secondary Group');
  const t = tree([top], {
    [top.uniqueId]: [secondary],
    [secondary.uniqueId]: [],
  });
  const p = plan(t, 'Top Group\nTop Group | Secondary Group');
  assert.equal(isNoOp(p), true);
  assert.deepEqual(p.creates, []);
});

test('a shared ancestor is only created once across rows', () => {
  const p = plan(tree([]), 'A | B | One\nA | B | Two');
  assert.deepEqual(
    p.creates.map((c) => c.display),
    ['A', 'A | B', 'A | B | One', 'A | B | Two'],
  );
});

test('ambiguous siblings are blocked rather than guessed', () => {
  const top = item('Top Group');
  // Two siblings that normalise identically — PM permits this, we must not pick one.
  const t = tree([top], {
    [top.uniqueId]: [item('Operations'), item('operations ')],
  });
  const p = plan(t, 'Top Group | Operations');
  assert.deepEqual(p.creates, []);
  assert.equal(p.blocked.length, 1);
  assert.match(p.blocked[0]!.message, /matches 2 existing groups/);
  // The way out is now in the spreadsheet rather than only in Process Manager, so the
  // message has to name both the column and the ids to choose between.
  assert.match(p.blocked[0]!.message, /Group Unique Id/);
  assert.match(p.blocked[0]!.message, /uid-\d+ \("Operations"\)/);
});

test('a document group cannot be used as an ancestor', () => {
  const docs = item('Random docs', 'documentgroup');
  const t = tree([docs], { [docs.uniqueId]: [] });
  const p = plan(t, 'Random docs | Something');
  assert.deepEqual(p.creates, []);
  assert.equal(p.blocked.length, 1);
  assert.match(p.blocked[0]!.message, /document-only group/);
});

test('one blocked path does not prevent unrelated paths from planning', () => {
  const top = item('Top Group');
  const t = tree([top], {
    [top.uniqueId]: [item('Operations'), item('Operations')],
  });
  const p = plan(t, 'Top Group | Operations\nElsewhere | Fine');
  assert.equal(p.blocked.length, 1);
  assert.deepEqual(
    p.creates.map((c) => c.display),
    ['Elsewhere', 'Elsewhere | Fine'],
  );
});

test('planning asks for unloaded levels instead of assuming they are empty', () => {
  // Root exists but its children have never been fetched. Concluding "missing" here
  // would create a duplicate of a group that already exists.
  const top = item('Top Group');
  const t = addLevel(emptyTree(), null, [top]);
  const parsed = parseGroupCsv('Top Group | Secondary');
  const outcome = planGroups(t, parsed.rows);
  assert.equal(outcome.status, 'needs-load');
  assert.ok(outcome.status === 'needs-load');
  assert.deepEqual(outcome.uniqueIds, [top.uniqueId]);
});

test('planning converges once the requested level is loaded', () => {
  const top = item('Top Group');
  const t = addLevel(emptyTree(), null, [top]);
  const parsed = parseGroupCsv('Top Group | Secondary');

  const first = planGroups(t, parsed.rows);
  assert.ok(first.status === 'needs-load');

  addLevel(t, top.uniqueId, []);
  const second = planGroups(t, parsed.rows);
  assert.ok(second.status === 'ok');
  assert.equal(second.plan.creates.length, 1);
  assert.equal(second.plan.creates[0]?.display, 'Top Group | Secondary');
});

test('a grandchild of an existing group attaches to its real parent', () => {
  // Regression: resolvePath reports the deepest *existing* node, which for "A|B|C"
  // with only A existing is A — not C's parent. Trusting it attaches C to A.
  const a = item('A');
  const t = tree([a], { [a.uniqueId]: [] });
  const p = plan(t, 'A | B | C');

  assert.deepEqual(
    p.creates.map((c) => c.display),
    ['A | B', 'A | B | C'],
  );
  assert.deepEqual(p.creates[0]?.parent, {
    kind: 'existing',
    uniqueId: a.uniqueId,
    display: 'A',
  });
  assert.deepEqual(p.creates[1]?.parent, { kind: 'planned', seq: 0, display: 'A | B' });
});

// ------------------------------------------------------------- group ids

/** A tree item with a real GUID, which is the only shape the CSV parser accepts. */
function guidItem(title: string, guid: string, itemType: TreeItemType = 'group'): TreeItem {
  return { ...item(title, itemType), uniqueId: guid };
}

const ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';
const ID_C = 'cccccccc-1111-2222-3333-444444444444';

test('an id picks one of two siblings that share a name', () => {
  // The reason the column exists. Without an id this path is unresolvable, and the
  // tenant genuinely contains pairs like this.
  const top = item('Crestan');
  const t = tree([top], {
    [top.uniqueId]: [guidItem('Finance', ID_A), guidItem('Finance', ID_B)],
  });

  const p = plan(t, `Group Unique Id,Level 1,Level 2\n${ID_B},Crestan,Finance`);
  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.creates, []);
  assert.equal(p.existing.find((e) => e.display === 'Crestan | Finance')?.uniqueId, ID_B);
});

test('an id on the parent row lets children of a duplicated group resolve', () => {
  // The ambiguity is at the parent, so the child cannot fix it with its own id — the
  // parent's row has to pin the path first.
  const top = item('Crestan');
  const finance = guidItem('Finance', ID_B);
  const t = tree([top], {
    [top.uniqueId]: [guidItem('Finance', ID_A), finance],
    [ID_A]: [],
    [ID_B]: [],
  });

  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2,Level 3',
      `${ID_B},Crestan,Finance,`,
      ',Crestan,Finance,Accounts Payable',
    ].join('\n'),
  );

  assert.deepEqual(p.blocked, []);
  assert.deepEqual(
    p.creates.map((c) => c.display),
    ['Crestan | Finance | Accounts Payable'],
  );
  // Nested under the group the id named, not the other one.
  assert.deepEqual(p.creates[0]?.parent, {
    kind: 'existing',
    uniqueId: ID_B,
    display: 'Crestan | Finance',
  });
});

test('rows are pinned shallowest first, whatever order the file is in', () => {
  const top = item('Crestan');
  const t = tree([top], {
    [top.uniqueId]: [guidItem('Finance', ID_A), guidItem('Finance', ID_B)],
    [ID_A]: [],
    [ID_B]: [guidItem('Accounts Payable', ID_C)],
  });

  // Child row first. Its own id cannot help until the parent row has pinned "Finance".
  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2,Level 3',
      `${ID_C},Crestan,Finance,Accounts Payable`,
      `${ID_B},Crestan,Finance,`,
    ].join('\n'),
  );

  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.creates, []);
});

test('an id naming a group that no longer exists is blocked, never recreated', () => {
  const top = item('Crestan');
  const t = tree([top], { [top.uniqueId]: [guidItem('Finance', ID_A)] });

  const p = plan(t, `Group Unique Id,Level 1,Level 2\n${ID_B},Crestan,Finance`);
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.renames, []);
  assert.deepEqual(p.moves, []);
  assert.equal(p.blocked.length, 1);
  assert.match(p.blocked[0]!.message, new RegExp(`No group with id ${ID_B}`));
  assert.match(p.blocked[0]!.message, /may have been deleted/);
});

test('both halves of a duplicated pair round-trip without being touched', () => {
  // Re-uploading an untouched export must be a no-op even where the export contains
  // two groups with the same path.
  const top = item('Crestan');
  const t = tree([top], {
    [top.uniqueId]: [guidItem('Finance', ID_A), guidItem('Finance', ID_B)],
  });

  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2',
      `${ID_A},Crestan,Finance`,
      `${ID_B},Crestan,Finance`,
    ].join('\n'),
  );

  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.blocked, []);
  assert.ok(isNoOp(p));
});

test('a path with no id behaves exactly as it did before', () => {
  const top = item('Crestan');
  const t = tree([top], { [top.uniqueId]: [] });
  const p = plan(t, 'Group Unique Id,Level 1,Level 2\n,Crestan,Brand New');
  assert.deepEqual(
    p.creates.map((c) => c.display),
    ['Crestan | Brand New'],
  );
});

test('a row already in place under a duplicated parent is left alone', () => {
  // Its id says which group it is, and it is exactly where the file puts it — so every
  // ancestor exists by definition. Re-deriving them by name would block the row on an
  // ambiguity that changes nothing, and make re-uploading an export report errors.
  const top = item('Crestan');
  const t = tree([top], {
    [top.uniqueId]: [guidItem('Finance', ID_A), guidItem('Finance', ID_B)],
    [ID_A]: [],
    [ID_B]: [guidItem('Procure to Pay', ID_C)],
  });

  const p = plan(t, `Group Unique Id,Level 1,Level 2,Level 3\n${ID_C},Crestan,Finance,Procure to Pay`);
  assert.deepEqual(p.blocked, []);
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.moves, []);
  assert.ok(isNoOp(p));
});

test('a new group under a duplicated parent is still blocked', () => {
  // Nothing pins which "Finance" it belongs to, and guessing would put it under the
  // wrong one — invisibly, since both paths read identically.
  const top = item('Crestan');
  const t = tree([top], {
    [top.uniqueId]: [guidItem('Finance', ID_A), guidItem('Finance', ID_B)],
    [ID_A]: [],
    [ID_B]: [],
  });

  const p = plan(t, 'Group Unique Id,Level 1,Level 2,Level 3\n,Crestan,Finance,Brand New');
  assert.deepEqual(p.creates, []);
  assert.equal(p.blocked.length, 1);
  assert.match(p.blocked[0]!.message, /"Crestan \| Finance" matches 2 existing groups/);
  assert.match(p.blocked[0]!.message, new RegExp(GROUP_ID_HEADER));
});

// --------------------------------------------------------- rename & move

const ID_D = 'dddddddd-1111-2222-3333-444444444444';

test('a changed name on an id row is a rename, not a second group', () => {
  const top = item('Crestan');
  const t = tree([top], { [top.uniqueId]: [guidItem('Finance', ID_A)], [ID_A]: [] });

  const p = plan(t, `Group Unique Id,Level 1,Level 2\n${ID_A},Crestan,Finance & Legal`);
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.moves, []);
  assert.deepEqual(p.renames, [
    {
      uniqueId: ID_A,
      fromDisplay: 'Crestan | Finance',
      from: 'Finance',
      to: 'Finance & Legal',
      line: 2,
    },
  ]);
});

test('case and inner spacing alone do not churn a rename', () => {
  // Matching is case- and whitespace-insensitive, so a file whose spelling drifted must
  // not push every group in the tenant through a pointless write.
  const top = item('Crestan');
  const t = tree([top], { [top.uniqueId]: [guidItem('Finance  Team', ID_A)], [ID_A]: [] });
  const p = plan(t, `Group Unique Id,Level 1,Level 2\n${ID_A},Crestan,finance team`);
  assert.deepEqual(p.renames, []);
  assert.ok(isNoOp(p));
});

test('a changed parent on an id row is a move', () => {
  const ops = item('Operations');
  const t = tree([item('Crestan'), ops], {
    [ops.uniqueId]: [],
  });
  // Finance currently sits under Crestan; the file puts it under Operations.
  const crestan = t.roots[0]!;
  addLevel(t, crestan.uniqueId, [guidItem('Finance', ID_A)]);
  addLevel(t, ID_A, []);

  const p = plan(t, `Group Unique Id,Level 1,Level 2\n${ID_A},Operations,Finance`);
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.renames, []);
  assert.equal(p.moves.length, 1);
  assert.equal(p.moves[0]?.uniqueId, ID_A);
  assert.equal(p.moves[0]?.fromDisplay, 'Crestan | Finance');
  assert.equal(p.moves[0]?.toDisplay, 'Operations | Finance');
  assert.deepEqual(p.moves[0]?.toParent, {
    kind: 'existing',
    uniqueId: ops.uniqueId,
    display: 'Operations',
  });
});

test('a group can be moved to the top level', () => {
  const crestan = item('Crestan');
  const t = tree([crestan], {
    [crestan.uniqueId]: [guidItem('Finance', ID_A)],
    [ID_A]: [],
  });

  const p = plan(t, `Group Unique Id,Level 1\n${ID_A},Finance`);
  assert.equal(p.moves.length, 1);
  assert.deepEqual(p.moves[0]?.toParent, { kind: 'root' });
});

test('a group can be moved under a group the same run creates', () => {
  const crestan = item('Crestan');
  const t = tree([crestan], {
    [crestan.uniqueId]: [guidItem('Finance', ID_A)],
    [ID_A]: [],
  });

  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2',
      ',Shared Services,',
      `${ID_A},Shared Services,Finance`,
    ].join('\n'),
  );

  assert.deepEqual(p.creates.map((c) => c.display), ['Shared Services']);
  // Resolved as a plan sequence: the destination has no id until the run creates it.
  assert.deepEqual(p.moves[0]?.toParent, { kind: 'planned', seq: 0, display: 'Shared Services' });
});

test('a rename and a move on the same row are both planned', () => {
  const ops = item('Operations');
  const crestan = item('Crestan');
  const t = tree([crestan, ops], {
    [crestan.uniqueId]: [guidItem('Finance', ID_A)],
    [ops.uniqueId]: [],
    [ID_A]: [],
  });

  const p = plan(t, `Group Unique Id,Level 1,Level 2\n${ID_A},Operations,Finance & Legal`);
  assert.equal(p.renames.length, 1);
  assert.equal(p.renames[0]?.to, 'Finance & Legal');
  assert.equal(p.moves.length, 1);
  assert.equal(p.moves[0]?.uniqueId, ID_A);
});

test('moving a group inside its own subgroup is refused', () => {
  // It would detach the whole subtree — a ring with no route back to a root.
  const crestan = item('Crestan');
  const t = tree([crestan], {
    [crestan.uniqueId]: [guidItem('Finance', ID_A)],
    [ID_A]: [guidItem('Payables', ID_B)],
    [ID_B]: [],
  });

  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2,Level 3',
      `${ID_B},Crestan,Payables,`,
      `${ID_A},Crestan,Payables,Finance`,
    ].join('\n'),
  );

  const cycle = p.blocked.find((b) => /one of its own subgroups/.test(b.message));
  assert.ok(cycle, `expected a cycle refusal, got ${JSON.stringify(p.blocked)}`);
  assert.equal(p.moves.some((m) => m.uniqueId === ID_A), false);
});

test('two moves that only form a cycle together are refused', () => {
  // Each is legal on its own against the tree as it stands, so the check has to run
  // against the structure the plan would produce.
  const t = tree([item('Root')]);
  const root = t.roots[0]!;
  addLevel(t, root.uniqueId, [guidItem('A', ID_C), guidItem('B', ID_D)]);
  addLevel(t, ID_C, []);
  addLevel(t, ID_D, []);

  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2,Level 3',
      `${ID_C},Root,B,A`,
      `${ID_D},Root,A,B`,
    ].join('\n'),
  );

  assert.ok(p.blocked.some((b) => /moves inside it/.test(b.message)));
});

test('moving into a document group is refused', () => {
  const docs = item('Random docs', 'documentgroup');
  const crestan = item('Crestan');
  const t = tree([crestan, docs], {
    [crestan.uniqueId]: [guidItem('Finance', ID_A)],
    [docs.uniqueId]: [],
    [ID_A]: [],
  });

  const p = plan(t, `Group Unique Id,Level 1,Level 2\n${ID_A},Random docs,Finance`);
  assert.deepEqual(p.moves, []);
  assert.ok(p.blocked.some((b) => /document-only group/.test(b.message)));
});

test('a row with no id never moves or renames anything', () => {
  // Without an id a path *is* the identity, so "not there" means "create it".
  const crestan = item('Crestan');
  const t = tree([crestan], {
    [crestan.uniqueId]: [item('Finance')],
  });
  const p = plan(t, 'Crestan | Finance Renamed');
  assert.deepEqual(p.renames, []);
  assert.deepEqual(p.moves, []);
  assert.deepEqual(p.creates.map((c) => c.display), ['Crestan | Finance Renamed']);
});

test('an untouched export of a tenant with duplicate names re-uploads as a no-op', () => {
  // Regression: the destination parent used to be re-derived by name, and a path two
  // groups answer to resolved to whichever was seen first — so a child of the *second*
  // "Finance" was planned as a move into the first. Silent, and destructive.
  const crestan = item('Crestan');
  const t = tree([crestan], {
    [crestan.uniqueId]: [guidItem('Finance', ID_A), guidItem('Finance', ID_B)],
    [ID_A]: [],
    [ID_B]: [guidItem('Procure to Pay', ID_C)],
    [ID_C]: [],
  });

  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2,Level 3',
      `${ID_A},Crestan,Finance,`,
      `${ID_B},Crestan,Finance,`,
      `${ID_C},Crestan,Finance,Procure to Pay`,
    ].join('\n'),
  );

  assert.deepEqual(p.moves, []);
  assert.deepEqual(p.renames, []);
  assert.deepEqual(p.creates, []);
  assert.deepEqual(p.blocked, []);
  assert.ok(isNoOp(p));
});

test('a move into a path two groups share is refused, not guessed', () => {
  // The rows for both "Finance" groups come first and are already in place, which pins
  // that path in the create pass's lookup table — to *one* of them. The move has to be
  // refused on the tree rather than trusting that lookup, or it silently picks a parent.
  const crestan = item('Crestan');
  const t = tree([crestan], {
    [crestan.uniqueId]: [guidItem('Finance', ID_A), guidItem('Finance', ID_B), guidItem('HR', ID_C)],
    [ID_A]: [],
    [ID_B]: [],
    [ID_C]: [],
  });

  const p = plan(
    t,
    [
      'Group Unique Id,Level 1,Level 2,Level 3',
      `${ID_A},Crestan,Finance,`,
      `${ID_B},Crestan,Finance,`,
      `${ID_C},Crestan,Finance,HR`,
    ].join('\n'),
  );

  assert.deepEqual(p.moves, []);
  assert.equal(p.blocked.length, 1);
  assert.match(p.blocked[0]!.message, /no telling which one "HR" should move into/);
});
