import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCsv } from './detect.ts';

const PROCESS_LIST_HEADER =
  'Group Name,Process Name,Status,Process Owner,Process Expert,Star Rating,Simplicity,' +
  'Effectiveness,Created Date,Modified Date,Modified By,Version,Minimode Url,' +
  'Minimode Issued Date,Minimode Issued By,Group Path,Short Cut,Source Group,' +
  'Source Group Path,Process Unique Id';

test('a file pairing process ids with group ids is the upload format', () => {
  assert.equal(
    classifyCsv('Process Unique Id,Process Name,Group Unique Id,Action\nw,x,y,z').kind,
    'shortcut-file',
  );
});

test('the shorter header spellings are recognised too', () => {
  assert.equal(classifyCsv('Process ID,Group ID\nx,y').kind, 'shortcut-file');
});

test("Process Manager's export is recognised as a seed, not an upload", () => {
  assert.equal(classifyCsv(`${PROCESS_LIST_HEADER}\n`).kind, 'process-list');
});

test('that export with a Group Unique Id column added is an upload', () => {
  // The workflow in PLAN.md §4.5 ends with exactly this file, so it must not be
  // turned away as "already an export".
  assert.equal(
    classifyCsv(`${PROCESS_LIST_HEADER},Group Unique Id,Action\n`).kind,
    'shortcut-file',
  );
});

test('the retired wide format is named, so the error can explain the change', () => {
  assert.equal(
    classifyCsv('Process Unique Id,Process Name,Shortcut 1\nx,y,z').kind,
    'legacy-shortcut-file',
  );
  assert.equal(
    classifyCsv(`${PROCESS_LIST_HEADER},Shortcut 1,Shortcut 2\n`).kind,
    'legacy-shortcut-file',
  );
});

test('a single-column file is the group file', () => {
  assert.equal(classifyCsv('Group Path\nTop | Second').kind, 'group-file');
});

test('a group file without a header row is still recognised', () => {
  // parseGroupCsv accepts a headerless file, so detection must too — otherwise a
  // valid upload gets refused before it reaches the parser.
  assert.equal(classifyCsv('Top Group | Secondary\nTop Group | Other').kind, 'group-file');
});

test('an empty file is unknown, not mistaken for a group file', () => {
  assert.equal(classifyCsv('').kind, 'unknown');
});

test('an unrelated spreadsheet is refused rather than guessed at', () => {
  assert.equal(classifyCsv('Name,Email,Department\nA,b@c.d,Ops').kind, 'unknown');
});

test('a wide group file is recognised however many columns it has', () => {
  // The header Excel produces when the old template is split across columns. Before
  // this it fell through to "unknown" and the upload was refused.
  assert.equal(classifyCsv('Group Path,,\nTop Group,Secondary Group,Lower').kind, 'group-file');
});

test('a group file with ids and Level headers is recognised', () => {
  assert.equal(
    classifyCsv('Group Unique Id,Level 1,Level 2\nabc,Finance,Procure to Pay').kind,
    'group-file',
  );
});

test("a Process List export is still the export, not a wide group file", () => {
  // It has a "Group Path" column too, so the process columns are what tell them apart.
  assert.equal(classifyCsv(`${PROCESS_LIST_HEADER}\n`).kind, 'process-list');
});
