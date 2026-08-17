import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseGroupCsv } from '../csv/groups.ts';
import type { GroupChampions } from '../pm/champions.ts';
import type { DirectoryUser } from '../pm/scim.ts';
import { planGroups } from './groupPlan.ts';
import type { GroupTree } from './tree.ts';
import { addLevel, emptyTree } from './tree.ts';
import { championLookupIds, planChampions, type ChampionPlanDeps } from './championPlan.ts';
import type { TreeItem } from '../pm/types.ts';

const ID_LEGAL = 'aaaaaaaa-1111-2222-3333-444444444444';

let nextId = 900;
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

function tree(roots: TreeItem[], levels: Record<string, TreeItem[]> = {}): GroupTree {
  const t = addLevel(emptyTree(), null, roots);
  for (const [parent, children] of Object.entries(levels)) addLevel(t, parent, children);
  return t;
}

const USERS: Record<string, DirectoryUser> = {
  'jonathan@palouse.io': {
    userId: 1054,
    logon: 'jonathan@palouse.io',
    displayName: 'JB Butler',
    active: true,
  },
  'bohdan.pavlenko@nintex.com': {
    userId: 1084,
    logon: 'bohdan.pavlenko@nintex.com',
    displayName: 'Bohdan Pavlenko',
    active: true,
  },
  'eugene.jones@nintex.com': {
    userId: 1079,
    logon: 'eugene.jones@nintex.com',
    displayName: 'Eugene Jones',
    active: false,
  },
};

function deps(over: Partial<ChampionPlanDeps> = {}): ChampionPlanDeps {
  return {
    resolveUser: (logon) => USERS[logon] ?? null,
    currentOf: () => null,
    regionalEnabled: true,
    ...over,
  };
}

function plan(t: GroupTree, csv: string, over: Partial<ChampionPlanDeps> = {}) {
  const rows = parseGroupCsv(csv).rows;
  const outcome = planGroups(t, rows);
  assert.equal(outcome.status, 'ok');
  const groupPlan = outcome.status === 'ok' ? outcome.plan : null;
  assert.ok(groupPlan);
  return { rows, groupPlan, champions: planChampions(rows, groupPlan, deps(over)) };
}

test('a blank cell produces no action at all', () => {
  const legal = item('Legal');
  const t = tree([legal], { [legal.uniqueId]: [] });

  const { champions } = plan(t, 'Level 1,Champion\nLegal,\n');
  assert.deepEqual(champions.primary, []);
  assert.deepEqual(champions.regional, []);
});

test('a champion on a group being created names the create, not an id', () => {
  // The id does not exist yet, so the action has to survive until the runner has one.
  const { champions } = plan(tree([]), 'Level 1,Champion\nLegal,jonathan@palouse.io\n');

  assert.equal(champions.primary.length, 1);
  assert.deepEqual(champions.primary[0]?.target, { kind: 'planned', seq: 0 });
  assert.equal(champions.primary[0]?.person?.userId, 1054);
  assert.equal(champions.primary[0]?.before, null);
});

test('a champion already in place is not written again', () => {
  const legal = item('Legal', ID_LEGAL);
  const t = tree([legal], { [ID_LEGAL]: [] });

  const current: GroupChampions = {
    primary: { userId: 1054, name: 'JB Butler' },
    regional: [],
    regionalEnabled: true,
  };

  const { champions } = plan(t, 'Level 1,Champion\nLegal,jonathan@palouse.io\n', {
    currentOf: () => current,
  });

  assert.deepEqual(champions.primary, []);
  assert.equal(champions.unchanged, 1);
});

test('a different champion is a replacement, and says who it replaces', () => {
  const legal = item('Legal', ID_LEGAL);
  const t = tree([legal], { [ID_LEGAL]: [] });

  const { champions } = plan(t, 'Level 1,Champion\nLegal,jonathan@palouse.io\n', {
    currentOf: () => ({
      primary: { userId: 27, name: 'Anjelica Farber' },
      regional: [],
      regionalEnabled: true,
    }),
  });

  assert.equal(champions.primary.length, 1);
  assert.equal(champions.primary[0]?.before, 'Anjelica Farber');
  assert.deepEqual(champions.primary[0]?.target, { kind: 'existing', uniqueId: ID_LEGAL });
});

test('CLEAR removes, and is a no-op where there is nobody to remove', () => {
  const legal = item('Legal', ID_LEGAL);
  const t = tree([legal], { [ID_LEGAL]: [] });

  const held = plan(t, 'Level 1,Champion\nLegal,CLEAR\n', {
    currentOf: () => ({
      primary: { userId: 27, name: 'Anjelica Farber' },
      regional: [],
      regionalEnabled: true,
    }),
  });
  assert.equal(held.champions.primary.length, 1);
  assert.equal(held.champions.primary[0]?.person, null);

  const empty = plan(t, 'Level 1,Champion\nLegal,CLEAR\n', {
    currentOf: () => ({ primary: null, regional: [], regionalEnabled: true }),
  });
  assert.deepEqual(empty.champions.primary, []);
  assert.equal(empty.champions.unchanged, 1);
});

test('an unknown logon blocks that row rather than picking somebody', () => {
  const { champions } = plan(tree([]), 'Level 1,Champion\nLegal,nobody@nowhere.io\n');

  assert.deepEqual(champions.primary, []);
  assert.equal(champions.blocked.length, 1);
  assert.match(champions.blocked[0]?.message ?? '', /No user has the logon/);
});

test('a logon two accounts share is blocked, not guessed at', () => {
  const { champions } = plan(tree([]), 'Level 1,Champion\nLegal,shared\n', {
    resolveUser: () => 'ambiguous',
  });

  assert.deepEqual(champions.primary, []);
  assert.match(champions.blocked[0]?.message ?? '', /More than one account/);
});

test('a deactivated account is applied but flagged', () => {
  const { champions } = plan(tree([]), 'Level 1,Champion\nLegal,eugene.jones@nintex.com\n');

  assert.equal(champions.primary.length, 1);
  assert.equal(champions.warnings.length, 1);
  assert.match(champions.warnings[0]?.message ?? '', /deactivated/);
});

test('a regional list is planned whole, because the write replaces', () => {
  const legal = item('Legal', ID_LEGAL);
  const t = tree([legal], { [ID_LEGAL]: [] });

  const { champions } = plan(
    t,
    'Level 1,Regional Champions\nLegal,"AET: bohdan.pavlenko@nintex.com"\n',
    {
      currentOf: () => ({
        primary: null,
        regional: [{ userId: 27, name: 'Anjelica Farber', region: 'AET' }],
        regionalEnabled: true,
      }),
    },
  );

  assert.equal(champions.regional.length, 1);
  assert.deepEqual(champions.regional[0]?.people.map((p) => p.userId), [1084]);
  // Who is being displaced has to reach the preview, or a replace reads as an addition.
  assert.deepEqual(champions.regional[0]?.before, [{ region: 'AET', name: 'Anjelica Farber' }]);
});

test('the same regional list in a different order changes nothing', () => {
  const legal = item('Legal', ID_LEGAL);
  const t = tree([legal], { [ID_LEGAL]: [] });

  const { champions } = plan(
    t,
    'Level 1,Regional Champions\nLegal,"aet: jonathan@palouse.io; AET: bohdan.pavlenko@nintex.com"\n',
    {
      currentOf: () => ({
        primary: null,
        regional: [
          { userId: 1084, name: 'Bohdan Pavlenko', region: 'AET' },
          { userId: 1054, name: 'JB Butler', region: 'AET' },
        ],
        regionalEnabled: true,
      }),
    },
  );

  assert.deepEqual(champions.regional, []);
  assert.equal(champions.unchanged, 1);
});

test('the regional column is refused where the tenant does not have the feature', () => {
  const { champions } = plan(tree([]), 'Level 1,Regional Champions\nLegal,"AET: jonathan@palouse.io"\n', {
    regionalEnabled: false,
  });

  assert.deepEqual(champions.regional, []);
  assert.match(champions.blocked[0]?.message ?? '', /regional champions turned on/);
});

test('a deep row champions its own group, not one of its ancestors', () => {
  // plan.existing carries an entry per ancestor under the same line number, so anything
  // keyed on the line alone hands the champion to the wrong group.
  const crestan = item('Crestan');
  const legal = item('Legal', ID_LEGAL);
  const t = tree([crestan], { [crestan.uniqueId]: [legal], [ID_LEGAL]: [] });

  const { champions } = plan(t, 'Level 1,Level 2,Champion\nCrestan,Legal,jonathan@palouse.io\n');

  assert.equal(champions.primary.length, 1);
  assert.deepEqual(champions.primary[0]?.target, { kind: 'existing', uniqueId: ID_LEGAL });
  assert.equal(champions.primary[0]?.display, 'Crestan | Legal');
});

test('only the groups a champion is actually named for get read', () => {
  const crestan = item('Crestan');
  const legal = item('Legal', ID_LEGAL);
  const t = tree([crestan], { [crestan.uniqueId]: [legal], [ID_LEGAL]: [] });

  const rows = parseGroupCsv(
    'Level 1,Level 2,Champion\nCrestan,Legal,jonathan@palouse.io\nCrestan,Risk,\n',
  ).rows;
  const outcome = planGroups(t, rows);
  assert.equal(outcome.status, 'ok');

  const ids = outcome.status === 'ok' ? championLookupIds(rows, outcome.plan) : [];
  assert.deepEqual(ids, [ID_LEGAL]);
});

test('a row the group planner refused is not reported twice', () => {
  const first = item('Legal');
  const second = item('Legal');
  const t = tree([first, second], { [first.uniqueId]: [], [second.uniqueId]: [] });

  const { champions } = plan(t, 'Level 1,Champion\nLegal,jonathan@palouse.io\n');
  assert.deepEqual(champions.blocked, []);
  assert.deepEqual(champions.primary, []);
});
