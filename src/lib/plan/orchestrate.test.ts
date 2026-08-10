import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupCsv } from '../csv/groups.ts';
import { parseShortcutCsv } from '../csv/shortcuts.ts';
import { pathKey } from '../csv/path.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type { ChildTreeItemsResponse, TreeItem, TreeItemType } from '../pm/types.ts';
import { buildGroupPlan, buildShortcutPlan, resolveShortcutTargets, type PlanGateway } from './orchestrate.ts';

const PROCESS = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';

let nextId = 2000;
function item(title: string, itemType: TreeItemType = 'group'): TreeItem {
  nextId += 1;
  return {
    id: nextId,
    uniqueId: `uid-${nextId}`,
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

// ------------------------------------------------------- shortcut targets

test('resolves existing shortcut targets to their group ids', async () => {
  const legal = item('Legal');
  const compliance = item('Compliance');
  const g = gateway({
    __root__: [legal],
    [legal.uniqueId]: [compliance],
    [compliance.uniqueId]: [],
  });

  const { tree } = await buildGroupPlan(g.impl, parseGroupCsv('Legal').rows);
  const rows = parseShortcutCsv(`Process ID,Shortcut 1\n${PROCESS},Legal | Compliance`).rows;
  const resolved = await resolveShortcutTargets(g.impl, rows, tree, []);

  assert.equal(resolved.get(pathKey(['Legal', 'Compliance']))?.uniqueId, compliance.uniqueId);
});

test('a shortcut can target a group the same run will create', async () => {
  // The upload creates "Brand | New" and points a shortcut at it in one go.
  const g = gateway({ __root__: [] });
  const groupRows = parseGroupCsv('Brand | New').rows;
  const { plan, tree } = await buildGroupPlan(g.impl, groupRows);

  const rows = parseShortcutCsv(`Process ID,Shortcut 1\n${PROCESS},Brand | New`).rows;
  const resolved = await resolveShortcutTargets(g.impl, rows, tree, plan.creates);

  const target = resolved.get(pathKey(['Brand', 'New']));
  assert.equal(target?.uniqueId, null);
  assert.equal(target?.plannedSeq, plan.creates[1]?.seq);
});

test('an unknown shortcut target stays unresolved for the planner to report', async () => {
  const g = gateway({ __root__: [] });
  const { tree } = await buildGroupPlan(g.impl, parseGroupCsv('Anything').rows);
  const rows = parseShortcutCsv(`Process ID,Shortcut 1\n${PROCESS},Nowhere | Missing`).rows;
  const resolved = await resolveShortcutTargets(g.impl, rows, tree, []);
  assert.equal(resolved.has(pathKey(['Nowhere', 'Missing'])), false);
});

// -------------------------------------------------------- shortcut plan

test('fetches process state and plans an update', async () => {
  const legal = item('Legal');
  const g = gateway(
    { __root__: [legal], [legal.uniqueId]: [] },
    { [PROCESS]: summary() },
  );

  const rows = parseShortcutCsv(`Process ID,Shortcut 1\n${PROCESS},Legal`).rows;
  const groups = new Map([
    [pathKey(['Legal']), { uniqueId: legal.uniqueId, id: legal.id, plannedSeq: null, name: 'Legal', display: 'Legal' }],
  ]);

  const { plan, unreadable } = await buildShortcutPlan(g.impl, rows, groups);
  assert.deepEqual(unreadable, []);
  assert.equal(plan.updates.length, 1);
  assert.deepEqual(plan.updates[0]?.writePath, { kind: 'publish-direct' });
});

test('blank rows are never fetched', async () => {
  // An exported file is mostly untouched rows; reading them all would be pure waste.
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

  const rows = parseShortcutCsv(`Process ID,Shortcut 1\n${PROCESS},`).rows;
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
    `Process ID,Shortcut 1\n${PROCESS},Legal\n${other},Legal`,
  ).rows;
  const groups = new Map([
    [pathKey(['Legal']), { uniqueId: legal.uniqueId, id: legal.id, plannedSeq: null, name: 'Legal', display: 'Legal' }],
  ]);

  const { plan, unreadable } = await buildShortcutPlan(g.impl, rows, groups);

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
    `Process ID,Shortcut 1\n${PROCESS},Legal\n${other},Legal`,
  ).rows;

  await buildShortcutPlan(g.impl, rows, new Map(), {
    concurrency: 1,
    onProgress: (e) => {
      if (e.phase === 'processes') seen.push(e.done);
    },
  });

  assert.deepEqual(seen, [1, 2]);
});
