import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupCsv } from '../csv/groups.ts';
import { parseShortcutCsv } from '../csv/shortcuts.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type { ChildTreeItemsResponse, TreeItem, TreeItemType } from '../pm/types.ts';
import {
  buildGroupPlan,
  buildShortcutPlan,
  indexGroupsById,
  loadWholeTree,
  type PlanGateway,
} from './orchestrate.ts';

const PROCESS = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';

let nextId = 2000;
function item(title: string, itemType: TreeItemType = 'group'): TreeItem {
  nextId += 1;
  return {
    id: nextId,
    // UUID-shaped, because the shortcut file will only accept a well-formed id and a
    // fixture that cannot be written into one would test the wrong thing.
    uniqueId: `00000000-0000-0000-0000-${String(nextId).padStart(12, '0')}`,
    title,
    itemType,
    itemOrder: 0,
    hasChild: true,
    totalSubgroups: 0,
    totalStakeholderUsers: 0,
    totalPermissionRoles: 1,
    totalPermissionUsers: 0,
    variationSetId: null,
  };
}

/** A gateway over a fixed tree, recording which levels were actually fetched. */
function gateway(
  levels: Record<string, TreeItem[]>,
  summaries: Record<string, ProcessSummary> = {},
) {
  const fetched: string[] = [];
  const impl: PlanGateway = {
    async groupsTree(parentUniqueId): Promise<ChildTreeItemsResponse> {
      const key = parentUniqueId ?? '__root__';
      fetched.push(key);
      return { treeItems: levels[key] ?? [], parentUniqueId };
    },
    async processSummary(processUniqueId): Promise<ProcessSummary> {
      const summary = summaries[processUniqueId];
      if (!summary) throw new Error(`no such process ${processUniqueId}`);
      return summary;
    },
    async groupViewers() {
      return [];
    },
  };
  return { impl, fetched };
}

function summary(over: Partial<ProcessSummary> = {}): ProcessSummary {
  return {
    uniqueId: PROCESS,
    name: 'PQL via BDR',
    version: '2.0',
    revisionEditId: 9180,
    revisionStateId: 3,
    homeGroupUniqueId: 'home',
    homeGroupName: 'Home',
    currentShortcuts: [],
    canEdit: true,
    canSave: true,
    canPublishAfterEdit: true,
    canSubmitForApprovalAfterEdit: true,
    ...over,
  };
}

// --------------------------------------------------------------- group plan

test('loads levels on demand and plans against them', async () => {
  const top = item('Top Group');
  const secondary = item('Secondary Group');
  const g = gateway({
    __root__: [top],
    [top.uniqueId]: [secondary],
    [secondary.uniqueId]: [],
  });

  const rows = parseGroupCsv('Top Group | Secondary Group | Lower').rows;
  const { plan } = await buildGroupPlan(g.impl, rows);

  assert.deepEqual(
    plan.creates.map((c) => c.display),
    ['Top Group | Secondary Group | Lower'],
  );
  assert.equal(plan.existing.length, 2);
});

test('only fetches the branches the CSV mentions', async () => {
  // A tenant has ~92 top-level trees; walking all of them would be hundreds of calls.
  const wanted = item('Wanted');
  const ignored = item('Ignored');
  const g = gateway({
    __root__: [wanted, ignored],
    [wanted.uniqueId]: [],
    [ignored.uniqueId]: [item('Never Loaded')],
  });

  await buildGroupPlan(g.impl, parseGroupCsv('Wanted | New Child').rows);

  assert.deepEqual(g.fetched, ['__root__', wanted.uniqueId]);
  assert.equal(g.fetched.includes(ignored.uniqueId), false);
});

test('an all-new structure needs only the root read', async () => {
  const g = gateway({ __root__: [] });
  const { plan } = await buildGroupPlan(g.impl, parseGroupCsv('A | B | C').rows);
  assert.equal(g.fetched.length, 1);
  assert.equal(plan.creates.length, 3);
});

test('a fully existing structure plans no creates', async () => {
  const a = item('A');
  const b = item('B');
  const g = gateway({ __root__: [a], [a.uniqueId]: [b], [b.uniqueId]: [] });
  const { plan } = await buildGroupPlan(g.impl, parseGroupCsv('A | B').rows);
  assert.deepEqual(plan.creates, []);
});

// -------------------------------------------------------- group id index

test('indexes every group by id, with its full path to read back', async () => {
  const legal = item('Legal');
  const compliance = item('Compliance');
  const g = gateway({
    __root__: [legal],
    [legal.uniqueId]: [compliance],
    [compliance.uniqueId]: [],
  });

  const index = indexGroupsById(await loadWholeTree(g.impl));

  assert.equal(index.get(compliance.uniqueId)?.id, compliance.id);
  assert.equal(index.get(compliance.uniqueId)?.display, 'Legal | Compliance');
  assert.equal(index.get(legal.uniqueId)?.display, 'Legal');
});

test('two groups sharing a name stay distinguishable', async () => {
  // The whole reason ids replaced paths: this tenant shape used to be unaddressable.
  const first = item('Finance');
  const second = item('Finance');
  const g = gateway({
    __root__: [first, second],
    [first.uniqueId]: [],
    [second.uniqueId]: [],
  });

  const index = indexGroupsById(await loadWholeTree(g.impl));

  assert.equal(index.size, 2);
  assert.notEqual(index.get(first.uniqueId)?.id, index.get(second.uniqueId)?.id);
});

test('an id the tenant does not have is simply absent', async () => {
  const g = gateway({ __root__: [] });
  const index = indexGroupsById(await loadWholeTree(g.impl));
  assert.equal(index.has('uid-nowhere'), false);
});

// -------------------------------------------------------- shortcut plan

/** The group lookup the planner takes, built by hand for a fixed tree. */
function groupIndex(node: TreeItem, display = node.title) {
  return new Map([
    [node.uniqueId, { uniqueId: node.uniqueId, id: node.id, name: node.title, display }],
  ]);
}

test('fetches process state and plans an update', async () => {
  const legal = item('Legal');
  const g = gateway({ __root__: [legal], [legal.uniqueId]: [] }, { [PROCESS]: summary() });

  const rows = parseShortcutCsv(
    `Process Unique Id,Group Unique Id\n${PROCESS},${legal.uniqueId}`,
  ).processes;

  const { plan, unreadable } = await buildShortcutPlan(g.impl, rows, groupIndex(legal), {
    published: 'republish',
  });
  assert.deepEqual(unreadable, []);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'publish-direct' });
});

test('re-planning applies a different publish choice without reading again', async () => {
  const legal = item('Legal');
  let reads = 0;
  const impl: PlanGateway = {
    async groupsTree() {
      return { treeItems: [], parentUniqueId: null };
    },
    async processSummary() {
      reads += 1;
      return summary();
    },
    async groupViewers() {
      return [];
    },
  };

  const rows = parseShortcutCsv(
    `Process Unique Id,Group Unique Id\n${PROCESS},${legal.uniqueId}`,
  ).processes;

  const { plan, replan } = await buildShortcutPlan(impl, rows, groupIndex(legal), {
    published: 'save',
  });
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'save-only' });

  const republished = replan({ published: 'republish' });
  assert.deepEqual(republished.updates[0]?.writePath, { kind: 'publish-direct' });
  assert.equal(reads, 1, 'the tenant is read once, whatever the operator picks');
});

test('rows naming no group are never fetched', async () => {
  // A generated worksheet is mostly untouched rows; reading them all would be waste.
  let reads = 0;
  const impl: PlanGateway = {
    async groupsTree() {
      return { treeItems: [], parentUniqueId: null };
    },
    async processSummary() {
      reads += 1;
      return summary();
    },
    async groupViewers() {
      return [];
    },
  };

  const rows = parseShortcutCsv(`Process Unique Id,Group Unique Id\n${PROCESS},`).processes;
  const { plan } = await buildShortcutPlan(impl, rows, new Map());

  assert.equal(reads, 0);
  assert.equal(plan.unchanged.length, 1);
});

test('one unreadable process does not abandon the rest of the plan', async () => {
  const other = 'b842a208-adbe-4c84-b6b8-7a23694da1ac';
  const legal = item('Legal');
  const g = gateway(
    { __root__: [legal] },
    { [other]: summary({ uniqueId: other, name: 'Other' }) },
  );

  const rows = parseShortcutCsv(
    `Process Unique Id,Group Unique Id\n${PROCESS},${legal.uniqueId}\n${other},${legal.uniqueId}`,
  ).processes;

  const { plan, unreadable } = await buildShortcutPlan(g.impl, rows, groupIndex(legal));

  assert.equal(unreadable.length, 1);
  assert.equal(unreadable[0]?.processUniqueId, PROCESS);
  // The readable one still planned.
  assert.equal(plan.updates.length, 1);
  assert.equal(plan.updates[0]?.processUniqueId, other);
  // And the unreadable one is reported, not silently dropped.
  assert.equal(plan.blocked.length, 1);
});

test('progress is reported while fetching processes', async () => {
  const legal = item('Legal');
  const other = 'b842a208-adbe-4c84-b6b8-7a23694da1ac';
  const g = gateway(
    { __root__: [legal] },
    { [PROCESS]: summary(), [other]: summary({ uniqueId: other }) },
  );

  const seen: number[] = [];
  const rows = parseShortcutCsv(
    `Process Unique Id,Group Unique Id\n${PROCESS},${legal.uniqueId}\n${other},${legal.uniqueId}`,
  ).processes;

  await buildShortcutPlan(g.impl, rows, new Map(), {
    concurrency: 1,
    onProgress: (e) => {
      if (e.phase === 'processes') seen.push(e.done);
    },
  });

  assert.deepEqual(seen, [1, 2]);
});
