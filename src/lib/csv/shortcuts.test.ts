import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShortcutCsv } from './shortcuts.ts';

const UUID = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';
const UUID2 = 'b842a208-adbe-4c84-b6b8-7a23694da1ac';

test('parses the documented shape', () => {
  const r = parseShortcutCsv(
    [
      'Process ID,Process Name,Current Group,Shortcut 1,Shortcut 2,Shortcut 3',
      `${UUID},(draft) PQL via BDR,Partner Manager Day to Day,Legal | Compliance,Finance & IT | Finance,`,
    ].join('\n'),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 1);

  const row = r.rows[0]!;
  assert.equal(row.processId, UUID);
  assert.equal(row.processName, '(draft) PQL via BDR');
  assert.ok(row.intent.kind === 'set');
  assert.deepEqual(row.intent.targets.map((t) => t.display), [
    'Legal | Compliance',
    'Finance & IT | Finance',
  ]);
});

test('reads as many Shortcut columns as the file provides', () => {
  // No fixed cap: eight columns must work exactly like three.
  const headers = ['Process ID', ...Array.from({ length: 8 }, (_, i) => `Shortcut ${i + 1}`)];
  const values = [UUID, ...Array.from({ length: 8 }, (_, i) => `Group ${i + 1}`)];
  const r = parseShortcutCsv(`${headers.join(',')}\n${values.join(',')}`);
  assert.deepEqual(r.errors, []);
  assert.ok(r.rows[0]!.intent.kind === 'set');
  assert.equal(r.rows[0]!.intent.targets.length, 8);
});

test('header spacing variants are accepted', () => {
  const r = parseShortcutCsv(`Process ID,shortcut1,SHORTCUT  2\n${UUID},A,B`);
  assert.deepEqual(r.errors, []);
  assert.ok(r.rows[0]!.intent.kind === 'set');
  assert.equal(r.rows[0]!.intent.targets.length, 2);
});

test('a misspelled shortcut column is an error, not a silent drop', () => {
  // "Shortcuts 1" would otherwise be ignored and a whole column of intent lost.
  const r = parseShortcutCsv(`Process ID,Shortcuts 1\n${UUID},Legal`);
  assert.ok(r.errors.some((e) => /not named correctly/.test(e.message)));
});

test('blank shortcut cells mean no change, not clear', () => {
  const r = parseShortcutCsv(`Process ID,Shortcut 1,Shortcut 2\n${UUID},,`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0]!.intent.kind, 'none');
});

test('CLEAR removes every shortcut', () => {
  const r = parseShortcutCsv(`Process ID,Shortcut 1,Shortcut 2\n${UUID},CLEAR,`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0]!.intent.kind, 'clear');
});

test('CLEAR is case-insensitive', () => {
  const r = parseShortcutCsv(`Process ID,Shortcut 1\n${UUID},clear`);
  assert.equal(r.rows[0]!.intent.kind, 'clear');
});

test('CLEAR mixed with real paths is contradictory and rejected', () => {
  const r = parseShortcutCsv(`Process ID,Shortcut 1,Shortcut 2\n${UUID},CLEAR,Legal | Compliance`);
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.message, /both CLEAR and shortcut paths/);
});

test('a malformed Process ID is rejected', () => {
  const r = parseShortcutCsv('Process ID,Shortcut 1\nnot-a-uuid,Legal');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.message, /not a valid Process ID/);
});

test('rows may be identified by name when no ID column exists', () => {
  const r = parseShortcutCsv(
    'Process Name,Current Group,Shortcut 1\nPQL via BDR,Partner Manager Day to Day,Legal',
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0]!.processId, null);
  assert.equal(r.rows[0]!.processName, 'PQL via BDR');
});

test('a file with no way to identify processes is rejected', () => {
  const r = parseShortcutCsv('Shortcut 1\nLegal');
  assert.match(r.errors[0]!.message, /"Process ID" column/);
});

test('a file with no shortcut columns is rejected', () => {
  const r = parseShortcutCsv(`Process ID,Process Name\n${UUID},x`);
  assert.match(r.errors[0]!.message, /nothing to apply/);
});

test('the same process listed twice is rejected', () => {
  const r = parseShortcutCsv(
    `Process ID,Shortcut 1\n${UUID},Legal\n${UUID},Finance`,
  );
  assert.equal(r.rows.length, 1);
  assert.match(r.errors[0]!.message, /same process as row 2/);
});

test('different processes are not confused with each other', () => {
  const r = parseShortcutCsv(
    `Process ID,Shortcut 1\n${UUID},Legal\n${UUID2},Finance`,
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
});

test('a repeated shortcut within one row is de-duplicated with a warning', () => {
  const r = parseShortcutCsv(
    `Process ID,Shortcut 1,Shortcut 2\n${UUID},Legal | Compliance,legal | compliance`,
  );
  assert.deepEqual(r.errors, []);
  assert.ok(r.rows[0]!.intent.kind === 'set');
  assert.equal(r.rows[0]!.intent.targets.length, 1);
  assert.equal(r.warnings.length, 1);
});

test('a malformed shortcut path fails its row without killing the file', () => {
  const r = parseShortcutCsv(
    `Process ID,Shortcut 1\n${UUID},Legal || Broken\n${UUID2},Finance`,
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.processId, UUID2);
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]!.line, 2);
});

test('blank rows between records are ignored', () => {
  const r = parseShortcutCsv(
    `Process ID,Shortcut 1\n${UUID},Legal\n\n\n${UUID2},Finance\n`,
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
});
