import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { TreeItem } from '../pm/types.ts';
import { findOrphanGroups } from './orphans.ts';
import { addLevel, emptyTree } from './tree.ts';

let id = 1;

function item(uniqueId: string, title: string): TreeItem {
  return {
    id: id++,
    uniqueId,
    title,
    itemType: 'group',
    itemOrder: 0,
    hasChild: false,
    totalSubgroups: null,
    totalStakeholderUsers: null,
    totalPermissionRoles: null,
    totalPermissionUsers: null,
    variationSetId: null,
  };
}

test('an unnamed group at the top level is found', () => {
  const tree = emptyTree();
  addLevel(tree, null, [item('g-legal', 'Legal'), item('g-orphan', 'New Group')]);

  const found = findOrphanGroups(tree);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.uniqueId, 'g-orphan');
  assert.equal(found[0]?.display, 'New Group');
});

test('an unnamed group deep in the tree is found, with its full path', () => {
  // The path is what makes it findable in Process Manager.
  const tree = emptyTree();
  addLevel(tree, null, [item('g-legal', 'Legal')]);
  addLevel(tree, 'g-legal', [item('g-comp', 'Compliance')]);
  addLevel(tree, 'g-comp', [item('g-orphan', 'New Group')]);

  const found = findOrphanGroups(tree);
  assert.equal(found[0]?.display, 'Legal | Compliance | New Group');
});

test('a tenant with no orphans reports none', () => {
  const tree = emptyTree();
  addLevel(tree, null, [item('g-legal', 'Legal')]);
  assert.deepEqual(findOrphanGroups(tree), []);
});

test('a group deliberately called "New Group" still counts', () => {
  // We cannot tell the difference, and neither can the matcher that will fail to find
  // it on the next run. Reporting it is the honest outcome.
  const tree = emptyTree();
  addLevel(tree, null, [item('g-x', 'new group')]);
  assert.equal(findOrphanGroups(tree).length, 1);
});

test('a name that merely contains the placeholder is not an orphan', () => {
  const tree = emptyTree();
  addLevel(tree, null, [item('g-x', 'New Group Onboarding')]);
  assert.deepEqual(findOrphanGroups(tree), []);
});
