import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { GroupPlan, MoveAction } from './groupPlan.ts';
import { addLevel, emptyTree, type GroupTree } from './tree.ts';
import type { TreeItem } from '../pm/types.ts';
import { audienceChanges, describeVisibility, viewerLookupIds } from './visibility.ts';

function item(id: number, uniqueId: string, title: string): TreeItem {
  return {
    id,
    uniqueId,
    title,
    itemType: 'group',
    itemOrder: 0,
    hasChild: false,
    totalSubgroups: 0,
    totalStakeholderUsers: 0,
    totalPermissionRoles: 0,
    totalPermissionUsers: 0,
    variationSetId: null,
  };
}

/** Finance (id 11) currently under Crestan (10); Operations is 12. */
function tenant(): GroupTree {
  const t = emptyTree();
  addLevel(t, null, [item(10, 'g-crestan', 'Crestan'), item(12, 'g-ops', 'Operations')]);
  addLevel(t, 'g-crestan', [item(11, 'g-finance', 'Finance')]);
  addLevel(t, 'g-ops', []);
  addLevel(t, 'g-finance', []);
  return t;
}

function move(over: Partial<MoveAction> = {}): MoveAction {
  return {
    uniqueId: 'g-finance',
    name: 'Finance',
    fromDisplay: 'Crestan | Finance',
    fromParentUniqueId: 'g-crestan',
    toPath: ['Operations', 'Finance'],
    toDisplay: 'Operations | Finance',
    toParent: { kind: 'existing', uniqueId: 'g-ops', display: 'Operations' },
    line: 2,
    ...over,
  };
}

function plan(moves: MoveAction[]): GroupPlan {
  return { creates: [], renames: [], moves, existing: [], blocked: [] };
}

test('the lookup asks for the group and its destination, by numeric id', () => {
  // The endpoint takes numeric groupIds while everything else here uses UUIDs.
  assert.deepEqual(viewerLookupIds(tenant(), plan([move()])), [11, 12]);
});

test('one batch call covers every move, however many there are', () => {
  const ids = viewerLookupIds(
    tenant(),
    plan([move(), move({ uniqueId: 'g-finance', line: 3 })]),
  );
  assert.deepEqual(ids, [11, 12], 'deduplicated rather than repeated per move');
});

test('a changed audience is reported at both ends', () => {
  const described = describeVisibility(tenant(), plan([move()]), [
    { groupId: 11, totalUsers: 12, totalRoles: 3 },
    { groupId: 12, totalUsers: 1, totalRoles: 1 },
  ]);

  assert.deepEqual(described[0]?.before, { users: 12, roles: 3 });
  assert.deepEqual(described[0]?.after, { users: 1, roles: 1 });
  assert.equal(audienceChanges(described).length, 1);
});

test('a move that changes nobody is not flagged', () => {
  // A tidy-up, not a decision. Flagging it would bury the moves that matter.
  const described = describeVisibility(tenant(), plan([move()]), [
    { groupId: 11, totalUsers: 4, totalRoles: 2 },
    { groupId: 12, totalUsers: 4, totalRoles: 2 },
  ]);
  assert.deepEqual(audienceChanges(described), []);
});

test('a destination this run creates reports as unknown, never as zero', () => {
  // "0 users" would read as "nobody will see this"; the truth is that it has no
  // permissions yet because it does not exist.
  const described = describeVisibility(
    tenant(),
    plan([move({ toParent: { kind: 'planned', seq: 0, display: 'Shared' } })]),
    [{ groupId: 11, totalUsers: 12, totalRoles: 3 }],
  );

  assert.equal(described[0]?.after, null);
  assert.equal(described[0]?.intoNewParent, true);
  assert.deepEqual(audienceChanges(described), [], 'nothing to compare, so nothing claimed');
});

test('counts that came back empty leave every move unknown rather than zeroed', () => {
  const described = describeVisibility(tenant(), plan([move()]), []);
  assert.equal(described[0]?.before, null);
  assert.equal(described[0]?.after, null);
  assert.deepEqual(audienceChanges(described), []);
});
