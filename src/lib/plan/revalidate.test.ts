import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ChildTreeItemsResponse } from '../pm/types.ts';
import type { TreeItem } from '../pm/types.ts';
import type { GroupPlan } from './groupPlan.ts';
import type { PlanGateway } from './orchestrate.ts';
import { revalidateGroupPlan } from './revalidate.ts';

let nextId = 700;
function item(title: string, uniqueId = `uid-${nextId++}`): TreeItem {
  return {
    id: nextId++,
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

/** A gateway over fixed levels, recording which were read. */
function gateway(levels: Record<string, TreeItem[]>) {
  const fetched: string[] = [];
  const impl: PlanGateway = {
    async groupsTree(parentUniqueId): Promise<ChildTreeItemsResponse> {
      const key = parentUniqueId ?? '__root__';
      fetched.push(key);
      return { treeItems: levels[key] ?? [], parentUniqueId };
    },
    async processSummary() {
      throw new Error('not used');
    },
    async groupViewers() {
      return [];
    },
    async usersDirectory() {
      return [];
    },
    async groupChampions() {
      return { primary: null, regional: [], regionalEnabled: false };
    },
  };
  return { impl, fetched };
}

function emptyPlan(over: Partial<GroupPlan> = {}): GroupPlan {
  return { creates: [], renames: [], moves: [], existing: [], blocked: [], ...over };
}

const create = (name: string, parent: string | null) => ({
  seq: 0,
  path: parent === null ? [name] : ['Parent', name],
  display: parent === null ? name : `Parent | ${name}`,
  name,
  parent:
    parent === null
      ? ({ kind: 'root' } as const)
      : ({ kind: 'existing', uniqueId: parent, display: 'Parent' } as const),
  line: 2,
});

test('a plan that still matches the tenant produces nothing', async () => {
  const { impl } = gateway({ 'uid-parent': [item('Something Else')] });
  const findings = await revalidateGroupPlan(impl, emptyPlan({ creates: [create('Legal', 'uid-parent')] }));
  assert.deepEqual(findings, []);
});

test('a group somebody else created since the preview stops the run', async () => {
  // The executor has no existence check, so without this the file makes a second one.
  const { impl } = gateway({ 'uid-parent': [item('Legal')] });
  const findings = await revalidateGroupPlan(impl, emptyPlan({ creates: [create('Legal', 'uid-parent')] }));

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /now exists here/);
  assert.equal(findings[0]?.line, 2);
});

test('the clash is matched the way group names are matched everywhere else', async () => {
  const { impl } = gateway({ __root__: [item('  legal   team ')] });
  const findings = await revalidateGroupPlan(impl, emptyPlan({ creates: [create('Legal Team', null)] }));
  assert.equal(findings.length, 1);
});

test('each level is read once however many steps depend on it', async () => {
  const { impl, fetched } = gateway({ 'uid-parent': [] });
  await revalidateGroupPlan(
    impl,
    emptyPlan({
      creates: [
        create('One', 'uid-parent'),
        { ...create('Two', 'uid-parent'), seq: 1 },
        { ...create('Three', 'uid-parent'), seq: 2 },
      ],
    }),
  );

  assert.deepEqual(fetched, ['uid-parent']);
});

test('a parent this run creates is not read — it cannot hold anything yet', async () => {
  const { impl, fetched } = gateway({});
  await revalidateGroupPlan(
    impl,
    emptyPlan({
      creates: [
        {
          ...create('Child', null),
          parent: { kind: 'planned', seq: 0, display: 'Parent' },
        },
      ],
    }),
  );

  assert.deepEqual(fetched, []);
});

test('a group that has moved away since the preview stops its move', async () => {
  const { impl } = gateway({ 'uid-from': [] });
  const findings = await revalidateGroupPlan(
    impl,
    emptyPlan({
      moves: [
        {
          uniqueId: 'uid-legal',
          name: 'Legal',
          fromDisplay: 'Crestan | Legal',
          fromParentUniqueId: 'uid-from',
          toPath: ['Crestan', 'Risk', 'Legal'],
          toDisplay: 'Crestan | Risk | Legal',
          toParent: { kind: 'existing', uniqueId: 'uid-risk', display: 'Crestan | Risk' },
          line: 4,
        },
      ],
    }),
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /not in Crestan \| Legal any more/);
});

test('a rename onto a name a sibling has taken since is stopped', async () => {
  const { impl } = gateway({
    'uid-parent': [item('Finance', 'uid-finance'), item('Finance & Legal')],
  });

  const findings = await revalidateGroupPlan(
    impl,
    emptyPlan({
      renames: [
        {
          uniqueId: 'uid-finance',
          fromDisplay: 'Parent | Finance',
          fromParentUniqueId: 'uid-parent',
          from: 'Finance',
          to: 'Finance & Legal',
          line: 3,
        },
      ],
    }),
  );

  assert.equal(findings.length, 1);
  assert.match(findings[0]?.message ?? '', /already called/);
});

test('a level that cannot be read is not treated as evidence of a conflict', async () => {
  // Refusing to apply because a check failed would be worse than not checking.
  const impl: PlanGateway = {
    async groupsTree() {
      throw new Error('502');
    },
    async processSummary() {
      throw new Error('not used');
    },
    async groupViewers() {
      return [];
    },
    async usersDirectory() {
      return [];
    },
    async groupChampions() {
      return { primary: null, regional: [], regionalEnabled: false };
    },
  };

  const findings = await revalidateGroupPlan(impl, emptyPlan({ creates: [create('Legal', 'uid-parent')] }));
  assert.deepEqual(findings, []);
});
