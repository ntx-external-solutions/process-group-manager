import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupCsv } from './groups.ts';
import { parseShortcutCsv } from './shortcuts.ts';
import {
  groupExport,
  groupTemplate,
  shortcutExport,
  shortcutHeader,
  shortcutTemplate,
} from './template.ts';

test('the group template parses cleanly through our own parser', () => {
  // A template that our parser rejects would be a very embarrassing bug.
  const r = parseGroupCsv(groupTemplate());
  assert.deepEqual(r.errors, []);
  assert.ok(r.rows.length >= 2);
});

test('the shortcut template parses cleanly through our own parser', () => {
  const r = parseShortcutCsv(shortcutTemplate());
  assert.deepEqual(r.errors, []);
});

const id = (n: number): string => `${String(n).repeat(8)}-1111-2222-3333-444444444444`;

test('a group export round-trips back to the same paths', () => {
  const groups = [
    { uniqueId: id(1), path: ['Go To Market (Sales and Marketing)'] },
    { uniqueId: id(2), path: ['Go To Market (Sales and Marketing)', 'Marketing'] },
    { uniqueId: id(3), path: ['Partner Portal', 'Partner Facing '] },
  ];
  const r = parseGroupCsv(groupExport(groups));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(
    r.rows.map((x) => x.display),
    [
      'Go To Market (Sales and Marketing)',
      'Go To Market (Sales and Marketing) | Marketing',
      // Outer whitespace is trimmed on the way back in, by design.
      'Partner Portal | Partner Facing',
    ],
  );
});

test('a group export carries the id of every group back with it', () => {
  // Without this the file cannot say "this exact group", which is the only way to
  // address one of two siblings that share a name.
  const r = parseGroupCsv(
    groupExport([
      { uniqueId: id(1), path: ['Crestan', 'Finance'] },
      { uniqueId: id(2), path: ['Crestan', 'Finance'] },
    ]),
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(
    r.rows.map((x) => x.uniqueId),
    [id(1), id(2)],
  );
});

test('an export is wide enough for its deepest path', () => {
  const csv = groupExport([{ uniqueId: id(1), path: ['A', 'B', 'C', 'D', 'E'] }]);
  const r = parseGroupCsv(csv);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0]?.segments, ['A', 'B', 'C', 'D', 'E']);
});

test('the template uses one column per level', () => {
  // The shape operators asked for, and the one that survives a row being sorted or
  // deleted — every row spells out its whole path.
  const r = parseGroupCsv(groupTemplate());
  assert.equal(r.layout.style, 'columns');
  assert.deepEqual(r.rows.at(-1)?.segments, [
    'Top Group',
    'Secondary Group',
    'Lower Level Group 2',
  ]);
});

const PROCESS = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';
const LEGAL = '3f240d01-1c4a-4a3e-9d3a-2b0f5a6c8d90';
const FINANCE = '3c42fbb0-7e21-4a55-9a1f-6b7c8d9e0f11';

test('a shortcut export round-trips to the same group ids', () => {
  const csv = shortcutExport([
    {
      processUniqueId: PROCESS,
      processName: '(draft) PQL via BDR',
      currentGroup: 'Partner Manager Day to Day',
      shortcuts: [
        { uniqueId: LEGAL, display: 'Legal | Compliance' },
        { uniqueId: FINANCE, display: 'Finance & IT | Finance' },
      ],
    },
  ]);

  const r = parseShortcutCsv(csv);
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes.length, 1, 'two shortcuts, two rows, one process');
  assert.deepEqual(r.processes[0]!.add, [LEGAL, FINANCE]);
});

test('an untouched exported row re-applies what is already there', () => {
  // Export, edit some rows, re-upload: the rows nobody touched must plan to nothing.
  const csv = shortcutExport([
    {
      processUniqueId: PROCESS,
      processName: 'Untouched',
      currentGroup: 'Home',
      shortcuts: [{ uniqueId: LEGAL, display: 'Legal | Compliance' }],
    },
  ]);
  const row = parseShortcutCsv(csv).processes[0]!;
  assert.deepEqual(row.add, [LEGAL]);
  assert.deepEqual(row.remove, []);
  assert.equal(row.clear, false);
});

test('an export lists every shortcut, however many a process has', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({
    uniqueId: `${String(i).repeat(8)}-1111-2222-3333-444444444444`,
    display: `Group ${i + 1}`,
  }));
  const csv = shortcutExport([
    {
      processUniqueId: PROCESS,
      processName: 'Heavily cross-linked',
      currentGroup: 'Home',
      shortcuts: many,
    },
  ]);

  // An export must never truncate the state it claims to describe.
  assert.equal(parseShortcutCsv(csv).processes[0]!.add.length, 9);
});

test('a process with no shortcuts still gets a row, meaning no change', () => {
  const csv = shortcutExport([
    {
      processUniqueId: PROCESS,
      processName: 'No shortcuts',
      currentGroup: 'Home',
      shortcuts: [],
    },
  ]);
  const r = parseShortcutCsv(csv);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.processes[0]!.add, []);
});

test('shortcutHeader is the minimal upload shape', () => {
  assert.deepEqual(shortcutHeader(), [
    'Process Unique Id',
    'Process Name',
    'Group Unique Id',
    'Action',
  ]);
});
