import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupCsv } from '../csv/groups.ts';
import { planGroups } from '../plan/groupPlan.ts';
import { addLevel, emptyTree, type GroupTree } from '../plan/tree.ts';
import type { TreeItem, TreeItemType } from '../pm/types.ts';
import { buildStructurePreview, structureToText, type StructureNode } from './structure.ts';

let nextId = 1;

function item(
  title: string,
  over: { itemType?: TreeItemType; hasChild?: boolean } = {},
): TreeItem {
  return {
    id: nextId++,
    uniqueId: `g-${title.toLowerCase().replace(/\W+/g, '-')}`,
    title,
    itemType: over.itemType ?? 'group',
    itemOrder: 0,
    hasChild: over.hasChild ?? false,
    totalSubgroups: null,
    totalStakeholderUsers: null,
    totalPermissionRoles: null,
    totalPermissionUsers: null,
    variationSetId: null,
  };
}

/**
 * Tenant shape used throughout: three top-level groups, with Legal's branch loaded
 * two levels deep and Finance and Archive never looked at — which is exactly the
 * lazily-loaded shape a real plan produces.
 */
function tenant(): GroupTree {
  const tree = emptyTree();
  addLevel(tree, null, [
    item('Legal', { hasChild: true }),
    item('Finance', { hasChild: true }),
    item('Archive', { hasChild: true }),
  ]);
  addLevel(tree, 'g-legal', [item('Compliance'), item('Contracts')]);
  addLevel(tree, 'g-compliance', []);
  return tree;
}

/** Plan a CSV against a tree, looping until the (already loaded) tree satisfies it. */
function planFor(tree: GroupTree, csv: string) {
  const rows = parseGroupCsv(csv).rows;
  const outcome = planGroups(tree, rows);
  assert.equal(outcome.status, 'ok', 'test tree must be loaded deeply enough');
  return outcome.status === 'ok' ? outcome.plan : (undefined as never);
}

function find(nodes: readonly StructureNode[], name: string): StructureNode | null {
  for (const node of nodes) {
    if (node.name === name) return node;
    const hit = find(node.children, name);
    if (hit) return hit;
  }
  return null;
}

test('a new group is drawn inside the existing group it will live in', () => {
  const tree = tenant();
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nLegal | Compliance | Audit'));

  const compliance = find(preview.roots, 'Compliance');
  assert.equal(compliance?.status, 'existing');
  assert.deepEqual(
    compliance?.children.map((c) => [c.name, c.status]),
    [['Audit', 'new']],
  );
  assert.equal(preview.newCount, 1);
});

test('existing siblings are shown, so a new group is seen in context', () => {
  // The point of a structure preview: "Audit sits next to Contracts" is what tells
  // someone they have put it in the right place.
  const tree = tenant();
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nLegal | Compliance | Audit'));

  const legal = find(preview.roots, 'Legal');
  assert.deepEqual(legal?.children.map((c) => c.name), ['Compliance', 'Contracts']);
});

test('branches the file never mentions are not expanded', () => {
  // Finance and Archive still appear — they are top-level context — but nothing is
  // drawn beneath them, and they say so rather than looking empty.
  const tree = tenant();
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nLegal | Compliance | Audit'));

  const finance = find(preview.roots, 'Finance');
  assert.deepEqual(finance?.children, []);
  assert.equal(finance?.hasHiddenChildren, true);
});

test('a group with nothing below it is not marked as hiding anything', () => {
  const tree = tenant();
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nLegal | Contracts'));

  const contracts = find(preview.roots, 'Contracts');
  assert.equal(contracts?.hasHiddenChildren, false, 'loaded and childless');
});

test('a chain of new groups nests rather than flattening', () => {
  // The regression that matters: C must hang off B, not off the nearest group that
  // already exists.
  const tree = tenant();
  const preview = buildStructurePreview(
    tree,
    planFor(tree, 'Group Path\nLegal | New Branch | Deeper | Deepest'),
  );

  const branch = find(preview.roots, 'New Branch');
  assert.equal(branch?.status, 'new');
  const deeper = branch?.children[0];
  assert.equal(deeper?.name, 'Deeper');
  assert.equal(deeper?.children[0]?.name, 'Deepest');
});

test('a new top-level group appears beside the existing top-level groups', () => {
  const tree = tenant();
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nBrand New'));

  assert.deepEqual(
    preview.roots.map((r) => [r.name, r.status]),
    [
      ['Legal', 'existing'],
      ['Finance', 'existing'],
      ['Archive', 'existing'],
      ['Brand New', 'new'],
    ],
  );
});

test('new groups are drawn after existing siblings, where the API puts them', () => {
  const tree = tenant();
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nLegal | Audit'));

  const legal = find(preview.roots, 'Legal');
  assert.deepEqual(legal?.children.map((c) => c.name), ['Compliance', 'Contracts', 'Audit']);
});

test('a path that already exists in full adds nothing', () => {
  const tree = tenant();
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nLegal | Compliance'));

  assert.equal(preview.newCount, 0);
  assert.equal(find(preview.roots, 'Compliance')?.status, 'existing');
});

test('a document group is flagged, since it cannot hold process groups', () => {
  const tree = emptyTree();
  addLevel(tree, null, [item('Policies', { itemType: 'documentgroup' })]);
  const preview = buildStructurePreview(tree, planFor(tree, 'Group Path\nPolicies'));

  assert.equal(find(preview.roots, 'Policies')?.isDocumentGroup, true);
});

test('two files that differ only in nesting produce visibly different trees', () => {
  // The typo this view exists to catch: a missing "|" turns a child into a sibling.
  const tree = tenant();
  const nested = buildStructurePreview(tree, planFor(tenant(), 'Group Path\nAlpha | Beta'));
  const flat = buildStructurePreview(tree, planFor(tenant(), 'Group Path\nAlpha\nBeta'));

  assert.equal(find(nested.roots, 'Alpha')?.children.length, 1);
  assert.equal(find(flat.roots, 'Alpha')?.children.length, 0);
  assert.equal(flat.roots.filter((r) => r.status === 'new').length, 2);
});

test('the tree renders as indented text', () => {
  const tree = tenant();
  const preview = buildStructurePreview(
    tree,
    planFor(tree, 'Group Path\nLegal | Compliance | Audit'),
  );

  assert.equal(
    structureToText(preview),
    [
      'Legal',
      '  Compliance',
      '    Audit   (new)',
      '  Contracts',
      'Finance',
      '  …',
      'Archive',
      '  …',
    ].join('\n'),
  );
});
