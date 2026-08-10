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

test('a group export round-trips back to the same paths', () => {
  const paths = [
    ['Go To Market (Sales and Marketing)'],
    ['Go To Market (Sales and Marketing)', 'Marketing'],
    ['Partner Portal', 'Partner Facing '],
  ];
  const r = parseGroupCsv(groupExport(paths));
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

test('a shortcut export round-trips to the same intent', () => {
  const csv = shortcutExport([
    {
      processUniqueId: '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c',
      processName: '(draft) PQL via BDR',
      currentGroup: 'Partner Manager Day to Day',
      shortcuts: ['Legal | Compliance', 'Finance & IT | Finance'],
    },
  ]);

  const r = parseShortcutCsv(csv);
  assert.deepEqual(r.errors, []);
  const intent = r.rows[0]!.intent;
  assert.ok(intent.kind === 'set');
  assert.deepEqual(intent.targets.map((t) => t.display), [
    'Legal | Compliance',
    'Finance & IT | Finance',
  ]);
});

test('an untouched exported row is a no-op, not a clear', () => {
  // This is what makes replace semantics safe: export, edit some rows, re-upload.
  const csv = shortcutExport([
    {
      processUniqueId: '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c',
      processName: 'Untouched',
      currentGroup: 'Home',
      shortcuts: ['Legal | Compliance'],
    },
  ]);
  const intent = parseShortcutCsv(csv).rows[0]!.intent;
  assert.equal(intent.kind, 'set');
  assert.notEqual(intent.kind, 'clear');
});

test('an export widens to fit the process with the most shortcuts', () => {
  const many = Array.from({ length: 9 }, (_, i) => `Group ${i + 1}`);
  const csv = shortcutExport([
    {
      processUniqueId: '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c',
      processName: 'Heavily cross-linked',
      currentGroup: 'Home',
      shortcuts: many,
    },
  ]);

  const intent = parseShortcutCsv(csv).rows[0]!.intent;
  assert.ok(intent.kind === 'set');
  // An export must never truncate the state it claims to describe.
  assert.equal(intent.targets.length, 9);
});

test('a process with no shortcuts exports as blank cells, meaning no change', () => {
  const csv = shortcutExport([
    {
      processUniqueId: '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c',
      processName: 'No shortcuts',
      currentGroup: 'Home',
      shortcuts: [],
    },
  ]);
  assert.equal(parseShortcutCsv(csv).rows[0]!.intent.kind, 'none');
});

test('shortcutHeader numbers columns from one', () => {
  assert.deepEqual(shortcutHeader(2), [
    'Process Unique Id',
    'Process Name',
    'Current Group',
    'Shortcut 1',
    'Shortcut 2',
  ]);
});
