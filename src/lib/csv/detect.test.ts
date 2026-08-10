import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyCsv } from './detect.ts';

const PROCESS_LIST_HEADER =
  'Group Name,Process Name,Status,Process Owner,Process Expert,Star Rating,Simplicity,' +
  'Effectiveness,Created Date,Modified Date,Modified By,Version,Minimode Url,' +
  'Minimode Issued Date,Minimode Issued By,Group Path,Short Cut,Source Group,' +
  'Source Group Path,Process Unique Id';

test('a file with Shortcut columns is the upload format', () => {
  assert.equal(
    classifyCsv('Process Unique Id,Process Name,Current Group,Shortcut 1\nx,y,z,w').kind,
    'shortcut-file',
  );
});

test("Process Manager's export is recognised as a seed, not an upload", () => {
  assert.equal(classifyCsv(`${PROCESS_LIST_HEADER}\n`).kind, 'process-list');
});

test('that export with Shortcut columns added is an upload again', () => {
  // The workflow in PLAN.md §4.5 ends with exactly this file, so it must not be
  // turned away as "already an export".
  assert.equal(classifyCsv(`${PROCESS_LIST_HEADER},Shortcut 1,Shortcut 2\n`).kind, 'shortcut-file');
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
