import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseShortcutCsv } from './shortcuts.ts';

const UUID = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';
const UUID2 = 'b842a208-adbe-4c84-b6b8-7a23694da1ac';
const LEGAL = '3f240d01-1c4a-4a3e-9d3a-2b0f5a6c8d90';
const FINANCE = '3c42fbb0-7e21-4a55-9a1f-6b7c8d9e0f11';

test('parses the documented shape', () => {
  const r = parseShortcutCsv(
    [
      'Process Unique Id,Process Name,Group Unique Id,Action',
      `${UUID},(draft) PQL via BDR,${LEGAL},Add`,
      `${UUID},(draft) PQL via BDR,${FINANCE},Add`,
    ].join('\n'),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes.length, 1);

  const row = r.processes[0]!;
  assert.equal(row.processId, UUID);
  assert.equal(row.processName, '(draft) PQL via BDR');
  assert.deepEqual(row.add, [LEGAL, FINANCE]);
  assert.deepEqual(row.remove, []);
  assert.deepEqual(row.lines, [2, 3]);
  assert.equal(row.line, 2);
});

test('a process gains as many shortcuts as it has rows', () => {
  // No fixed cap. Eight rows must work exactly like two.
  const rows = Array.from(
    { length: 8 },
    (_, i) => `${UUID},x,${LEGAL.slice(0, -1)}${i},Add`,
  );
  const r = parseShortcutCsv(`Process Unique Id,Process Name,Group Unique Id,Action\n${rows.join('\n')}`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes.length, 1);
  assert.equal(r.processes[0]!.add.length, 8);
});

test('a blank Action means Add', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id,Action\n${UUID},${LEGAL},`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
});

test('the Action column is optional entirely', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id\n${UUID},${LEGAL}`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
});

test('Remove is read as a removal, whatever its case', () => {
  const r = parseShortcutCsv(
    `Process Unique Id,Group Unique Id,Action\n${UUID},${LEGAL},remove\n${UUID},${FINANCE},Add`,
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.processes[0]!.remove, [LEGAL]);
  assert.deepEqual(r.processes[0]!.add, [FINANCE]);
});

test('an unrecognised Action is rejected rather than treated as Add', () => {
  // Silently adding on "Delet" would do the opposite of what the row asks for.
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id,Action\n${UUID},${LEGAL},Delet`);
  assert.match(r.errors[0]!.message, /not a valid Action/);
});

test('header spelling variants are accepted', () => {
  const r = parseShortcutCsv(`Process ID,Group ID,Action\n${UUID},${LEGAL},Add`);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
});

test('group ids are matched case-insensitively', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id\n${UUID.toUpperCase()},${LEGAL.toUpperCase()}`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes[0]!.processId, UUID);
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
});

test('a row naming no group is a no-op, not an error', () => {
  // The generated worksheet has one of these per process the operator has not touched.
  const r = parseShortcutCsv(`Process Unique Id,Process Name,Group Unique Id,Action\n${UUID},x,,`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes.length, 1);
  assert.deepEqual(r.processes[0]!.add, []);
  assert.equal(r.processes[0]!.clear, false);
});

test('an Action with no group is an error, because it asks for something impossible', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id,Action\n${UUID},,Remove`);
  assert.match(r.errors[0]!.message, /names no group/);
});

test('CLEAR removes every shortcut', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id\n${UUID},CLEAR`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes[0]!.clear, true);
});

test('CLEAR is case-insensitive', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id\n${UUID},clear`);
  assert.equal(r.processes[0]!.clear, true);
});

test('CLEAR combined with an Add is a replace, not a contradiction', () => {
  // Clear the lot, then add these: the only way to express "exactly these shortcuts".
  const r = parseShortcutCsv(
    `Process Unique Id,Group Unique Id,Action\n${UUID},CLEAR,\n${UUID},${LEGAL},Add`,
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes[0]!.clear, true);
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
});

test('a malformed Process Unique Id is rejected', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id\nnot-a-uuid,${LEGAL}`);
  assert.equal(r.processes.length, 0);
  assert.match(r.errors[0]!.message, /not a valid Process Unique Id/);
});

test('a malformed Group Unique Id is rejected', () => {
  const r = parseShortcutCsv(`Process Unique Id,Group Unique Id\n${UUID},Legal | Compliance`);
  assert.match(r.errors[0]!.message, /not a valid Group Unique Id/);
});

test('a file with no process id column is rejected', () => {
  const r = parseShortcutCsv('Process Name,Group Unique Id\nPQL via BDR,x');
  assert.match(r.errors[0]!.message, /"Process Unique Id" column/);
});

test('a file with no group id column is rejected', () => {
  const r = parseShortcutCsv(`Process Unique Id,Process Name\n${UUID},x`);
  assert.match(r.errors[0]!.message, /"Group Unique Id" column/);
});

test('the retired wide format is named rather than called unrecognisable', () => {
  // Files built to it are out there. "Your columns match nothing" is a poor answer.
  const r = parseShortcutCsv(`Process Unique Id,Shortcut 1,Shortcut 2\n${UUID},Legal,Finance`);
  assert.match(r.errors[0]!.message, /old "Shortcut 1" columns/);
  assert.match(r.errors[0]!.message, /Group Unique Id/);
});

test('columns the file carries for the operator are ignored', () => {
  // The generated worksheet has these, and Process Manager's export has more of them.
  const r = parseShortcutCsv(
    'Process Unique Id,Process Name,Current Group,Current Shortcuts,Status,Group Unique Id,Action\n' +
      `${UUID},NPS Capture,Example Processes,Legal | Compliance,Suggested,${FINANCE},Add`,
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes[0]!.processName, 'NPS Capture');
  assert.deepEqual(r.processes[0]!.add, [FINANCE]);
});

test('the report\'s "Short Cut" column is not mistaken for a shortcut column', () => {
  // "Short Cut" (with a space) is a status flag in the report, not data we apply.
  const r = parseShortcutCsv(
    `Process Unique Id,Short Cut,Source Group,Group Unique Id\n${UUID},No,,${LEGAL}`,
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
});

test('rows for one process are folded together, in file order', () => {
  const r = parseShortcutCsv(
    [
      'Process Unique Id,Group Unique Id,Action',
      `${UUID},${LEGAL},Add`,
      `${UUID2},${LEGAL},Add`,
      `${UUID},${FINANCE},Add`,
    ].join('\n'),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes.length, 2);
  assert.deepEqual(r.processes[0]!.add, [LEGAL, FINANCE]);
  assert.deepEqual(r.processes[0]!.lines, [2, 4]);
  assert.deepEqual(r.processes[1]!.add, [LEGAL]);
});

test('adding and removing the same shortcut is contradictory and rejected', () => {
  const r = parseShortcutCsv(
    `Process Unique Id,Group Unique Id,Action\n${UUID},${LEGAL},Add\n${UUID},${LEGAL},Remove`,
  );
  assert.match(r.errors[0]!.message, /row 2 asks to add/i);
  // The contradictory row is dropped; the first still stands.
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
});

test('an exact duplicate row is de-duplicated with a warning', () => {
  const r = parseShortcutCsv(
    `Process Unique Id,Group Unique Id,Action\n${UUID},${LEGAL},Add\n${UUID},${LEGAL},Add`,
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.processes[0]!.add, [LEGAL]);
  assert.equal(r.warnings.length, 1);
});

test('the same group on two different processes is not a duplicate', () => {
  const r = parseShortcutCsv(
    `Process Unique Id,Group Unique Id\n${UUID},${LEGAL}\n${UUID2},${LEGAL}`,
  );
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.processes.length, 2);
});

test('a bad row fails on its own without killing the file', () => {
  const r = parseShortcutCsv(
    `Process Unique Id,Group Unique Id\n${UUID},nonsense\n${UUID2},${FINANCE}`,
  );
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]!.line, 2);
  assert.equal(r.processes.length, 2);
  assert.deepEqual(r.processes[1]!.add, [FINANCE]);
});

test('blank rows between records are ignored', () => {
  const r = parseShortcutCsv(
    `Process Unique Id,Group Unique Id\n${UUID},${LEGAL}\n\n\n${UUID2},${FINANCE}\n`,
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.processes.length, 2);
});

test('an empty file is reported as empty', () => {
  assert.match(parseShortcutCsv('').errors[0]!.message, /empty/);
});

test('a header with no rows under it is reported', () => {
  const r = parseShortcutCsv('Process Unique Id,Group Unique Id\n');
  assert.match(r.errors[0]!.message, /no process rows/);
});
