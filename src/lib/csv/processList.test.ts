import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseProcessListCsv, toShortcutCsv } from './processList.ts';
import { parseShortcutCsv } from './shortcuts.ts';

const HEADER =
  'Group Name,Process Name,Status,Process Owner,Process Expert,Star Rating,Simplicity,' +
  'Effectiveness,Created Date,Modified Date,Modified By,Version,Minimode Url,' +
  'Minimode Issued Date,Minimode Issued By,Group Path,Short Cut,Source Group,' +
  'Source Group Path,Process Unique Id';

const FIRST_PROCESS = '38c70a88-18a6-4b94-8ed7-c6fa0820852a';

/** Build a report row, defaulting the columns this module ignores. */
function row(over: {
  groupName?: string;
  name: string;
  status?: string;
  groupPath: string;
  shortCut?: 'Yes' | 'No';
  sourceGroup?: string;
  sourceGroupPath?: string;
  uid: string;
}): string {
  const cells = [
    over.groupName ?? '',
    over.name,
    over.status ?? 'Published',
    '', '', 'Unrated', 'Unrated', 'Unrated',
    '10 Aug 2026', '10 Aug 2026', 'Jonathan Butler',
    '', '', '', '',
    over.groupPath,
    over.shortCut ?? 'No',
    over.sourceGroup ?? '',
    over.sourceGroupPath ?? '',
    over.uid,
  ];
  return cells.map((c) => `"${c.replace(/"/g, '""')}"`).join(',');
}

const TOP_LEVEL = ['My Group', 'New Group', 'Crestan', 'Example Space'];

test('folds home and shortcut rows into one record per process', () => {
  // Verbatim shape from the real export: the shortcut row carries the same UUID as
  // the home row and points back at it via Source Group Path.
  const csv = [
    HEADER,
    row({
      name: 'First Process',
      groupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    }),
    row({
      name: 'First Process',
      groupPath: 'Promapp Demo Ltd. > My Group > First Process',
      shortCut: 'Yes',
      sourceGroup: 'Example Group',
      sourceGroupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    }),
  ].join('\n');

  const result = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL });
  assert.deepEqual(result.errors, []);
  assert.equal(result.processes.length, 1, 'two placements are one process');

  const p = result.processes[0]!;
  assert.deepEqual(p.homePath, ['New Group', 'Example Group']);
  assert.deepEqual(p.shortcutPaths, [['My Group']]);
});

test('strips the organisation prefix and the trailing process name', () => {
  const csv = [
    HEADER,
    row({
      name: 'Conduct Field Maintenance',
      groupPath: 'Promapp Demo Ltd. > My Group > Automated Testing > Conduct Field Maintenance',
      uid: '0f4a32f0-fea2-41e8-9f2e-c39787604d4d',
    }),
  ].join('\n');

  const p = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL }).processes[0]!;
  assert.deepEqual(p.homePath, ['My Group', 'Automated Testing']);
});

test('a leading segment that is a real top-level group is not stripped', () => {
  // An export filtered to one top-level group has no organisation prefix. Removing
  // the first segment there would re-home every process one level up.
  const csv = [
    HEADER,
    row({
      name: 'Thing',
      groupPath: 'My Group > Automated Testing > Thing',
      uid: '0f4a32f0-fea2-41e8-9f2e-c39787604d4d',
    }),
  ].join('\n');

  const p = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL }).processes[0]!;
  assert.deepEqual(p.homePath, ['My Group', 'Automated Testing']);
});

test('without known top-level groups the organisation prefix is inferred and flagged', () => {
  const csv = [
    HEADER,
    row({ name: 'A', groupPath: 'Promapp Demo Ltd. > My Group > A', uid: 'aaaaaaaa-0000-4000-8000-000000000001' }),
    row({ name: 'B', groupPath: 'Promapp Demo Ltd. > Crestan > B', uid: 'aaaaaaaa-0000-4000-8000-000000000002' }),
  ].join('\n');

  const result = parseProcessListCsv(csv);
  assert.deepEqual(result.processes[0]?.homePath, ['My Group']);
  assert.ok(result.warnings.some((w) => /organisation name/.test(w.message)));
});

test('a process whose name repeats a group name keeps that group', () => {
  // Only the trailing segment is the process name; an identically named ancestor
  // must survive.
  const csv = [
    HEADER,
    row({
      name: 'Security',
      groupPath: 'Promapp Demo Ltd. > Security > Security',
      uid: 'aaaaaaaa-0000-4000-8000-000000000003',
    }),
  ].join('\n');

  const p = parseProcessListCsv(csv, { topLevelGroups: ['Security'] }).processes[0]!;
  assert.deepEqual(p.homePath, ['Security']);
});

test('a shortcut row alone still yields a home path', () => {
  // Home row filtered out of the export; Source Group Path is the only clue.
  const csv = [
    HEADER,
    row({
      name: 'First Process',
      groupPath: 'Promapp Demo Ltd. > My Group > First Process',
      shortCut: 'Yes',
      sourceGroupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    }),
  ].join('\n');

  const p = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL }).processes[0]!;
  assert.deepEqual(p.homePath, ['New Group', 'Example Group']);
  assert.deepEqual(p.shortcutPaths, [['My Group']]);
});

test('multiple shortcuts collect onto one process', () => {
  const shortcut = (group: string) =>
    row({
      name: 'First Process',
      groupPath: `Promapp Demo Ltd. > ${group} > First Process`,
      shortCut: 'Yes',
      sourceGroupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    });

  const csv = [HEADER, shortcut('My Group'), shortcut('Crestan')].join('\n');
  const p = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL }).processes[0]!;
  assert.deepEqual(p.shortcutPaths, [['My Group'], ['Crestan']]);
});

test('a repeated placement is de-duplicated', () => {
  const dup = row({
    name: 'First Process',
    groupPath: 'Promapp Demo Ltd. > My Group > First Process',
    shortCut: 'Yes',
    sourceGroupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
    uid: FIRST_PROCESS,
  });
  const p = parseProcessListCsv([HEADER, dup, dup].join('\n'), {
    topLevelGroups: TOP_LEVEL,
  }).processes[0]!;
  assert.equal(p.shortcutPaths.length, 1);
});

test('distinct processes sharing a name stay distinct', () => {
  // 49% of rows in a real tenant share a name; only the UUID separates them.
  const csv = [
    HEADER,
    row({
      name: 'Finalise a Section 14 Transfer In request',
      groupPath: 'Promapp Demo Ltd. > My Group > Section 14 Transfer In > Finalise a Section 14 Transfer In request',
      uid: '60e43ad4-fb3b-4fe1-80f6-0dd748f94095',
    }),
    row({
      name: 'Finalise a Section 14 Transfer In request',
      groupPath: 'Promapp Demo Ltd. > My Group > Section 14 Transfer In > Finalise a Section 14 Transfer In request',
      uid: 'a64bc9c4-ca38-4813-90bf-216d040a9dcf',
    }),
  ].join('\n');

  const result = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL });
  assert.equal(result.processes.length, 2);
});

test('a file that is not a Process List export is rejected by name', () => {
  const result = parseProcessListCsv('Process ID,Shortcut 1\nx,y');
  assert.equal(result.processes.length, 0);
  assert.match(result.errors[0]!.message, /Process Unique Id/);
});

test('rows without a UUID are skipped with a warning, not fatally', () => {
  const csv = [
    HEADER,
    row({ name: 'Good', groupPath: 'Promapp Demo Ltd. > My Group > Good', uid: FIRST_PROCESS }),
    `"","Orphan","Published","","","","","","","","","","","","","Promapp Demo Ltd. > My Group > Orphan","No","","",""`,
  ].join('\n');

  const result = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL });
  assert.equal(result.processes.length, 1);
  assert.ok(result.warnings.some((w) => /no Process Unique Id/.test(w.message)));
});

// ------------------------------------------------------------ round trip

test('the generated file parses back through the shortcut parser', () => {
  const csv = [
    HEADER,
    row({
      name: 'First Process',
      groupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    }),
    row({
      name: 'First Process',
      groupPath: 'Promapp Demo Ltd. > My Group > First Process',
      shortCut: 'Yes',
      sourceGroupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    }),
  ].join('\n');

  const { processes } = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL });
  const generated = toShortcutCsv(processes);

  const parsed = parseShortcutCsv(generated);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.processes[0]?.processId, FIRST_PROCESS);
  assert.equal(parsed.processes[0]?.processName, 'First Process');
});

test('an untouched generated row changes nothing', () => {
  // The worksheet carries no group ids, so a row nobody edits cannot ask for anything.
  // Shortcuts are additive, so the ones it already has survive untouched.
  const csv = [
    HEADER,
    row({
      name: 'First Process',
      groupPath: 'Promapp Demo Ltd. > My Group > First Process',
      shortCut: 'Yes',
      sourceGroupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    }),
  ].join('\n');

  const { processes } = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL });
  const parsed = parseShortcutCsv(toShortcutCsv(processes));

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.processes[0]!.add, []);
  assert.equal(parsed.processes[0]!.clear, false);
});

test('the current shortcuts ride along for the operator to read', () => {
  // The ids are unreadable, so without this there is nothing in the file to check a
  // row against. The parser ignores the column.
  const csv = [
    HEADER,
    row({
      name: 'First Process',
      groupPath: 'Promapp Demo Ltd. > My Group > First Process',
      shortCut: 'Yes',
      sourceGroupPath: 'Promapp Demo Ltd. > New Group > Example Group > First Process',
      uid: FIRST_PROCESS,
    }),
  ].join('\n');

  const { processes } = parseProcessListCsv(csv, { topLevelGroups: TOP_LEVEL });
  const generated = toShortcutCsv(processes);
  assert.match(generated, /Current Shortcuts/);
  assert.match(generated, /My Group/);
});

test('a process appears once however many placements it has', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    row({
      name: 'Busy',
      groupPath: `Promapp Demo Ltd. > G${i} > Busy`,
      shortCut: 'Yes',
      sourceGroupPath: 'Promapp Demo Ltd. > Home > Busy',
      uid: FIRST_PROCESS,
    }),
  );
  const { processes } = parseProcessListCsv([HEADER, ...many].join('\n'));
  const parsed = parseShortcutCsv(toShortcutCsv(processes));
  assert.equal(parsed.processes.length, 1);
});
