import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupCsv } from '../csv/groups.ts';
import type { TreeItem, TreeItemType } from '../pm/types.ts';
import { addLevel, emptyTree, type GroupTree } from './tree.ts';
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
