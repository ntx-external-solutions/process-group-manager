import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseGroupCsv } from './groups.ts';

test('parses the shape from the brief', () => {
  const r = parseGroupCsv(
    [
      'Group Path',
      'Top Group',
      'Top Group | Secondary Group | Lower Level Group 1',
      'Top Group | Secondary Group | Lower Level Group 2',
    ].join('\n'),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[1]?.segments, [
    'Top Group',
    'Secondary Group',
    'Lower Level Group 1',
  ]);
});

test('the header row is optional', () => {
  const r = parseGroupCsv('Top Group\nTop Group | Secondary');
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0]?.display, 'Top Group');
});

test('blank rows are skipped, not treated as errors', () => {
  const r = parseGroupCsv('Group Path\nTop Group\n\n\nTop Group | Secondary\n');
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
});

test('comma-separated levels are rejected with a suggestion', () => {
  // The most likely non-technical mistake: commas instead of pipes. Parsing only
  // the first cell would silently discard their structure.
  const r = parseGroupCsv('Group Path\nTop Group,Secondary Group,Lower Level');
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.message, /separated by "\|"/);
  assert.match(r.errors[0]!.message, /Top Group \| Secondary Group \| Lower Level/);
});

test('line numbers point at the row the operator sees', () => {
  const r = parseGroupCsv('Group Path\nGood Group\nTop || Broken');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0]?.line, 3);
});

test('an exact duplicate path is a warning and is de-duplicated', () => {
  const r = parseGroupCsv('Top Group | Sales\nTop Group | Sales');
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /repeats/);
});

test('the same group spelled two ways is a hard error', () => {
  // We cannot know whether they want "Sales" or "SALES" created.
  const r = parseGroupCsv('Top Group | Sales\nTop Group | SALES');
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.message, /spelled differently/);
});

test('paths containing commas survive when quoted', () => {
  const r = parseGroupCsv('"Go To Market (Sales, Marketing) | Marketing"');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0]?.segments, [
    'Go To Market (Sales, Marketing)',
    'Marketing',
  ]);
});

test('an empty file is reported rather than silently accepted', () => {
  const r = parseGroupCsv('Group Path\n');
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.message, /no group paths/i);
});

test('one bad row does not discard the good ones', () => {
  const r = parseGroupCsv('Group Path\nGood One\nTop || Broken\nGood Two');
  assert.equal(r.rows.length, 2);
  assert.equal(r.errors.length, 1);
});

// ------------------------------------------------- one column per level

test('a header padded with empty columns is the wide shape', () => {
  // Exactly what Excel writes when someone splits the old template across columns
  // without renaming the headers. This is the file operators asked for.
  const r = parseGroupCsv(
    [
      'Group Path,,',
      'Top Group,,',
      'Top Group,Secondary Group,',
      'Top Group,Secondary Group,Lower Level Group 1',
      'Top Group,Secondary Group,Lower Level Group 2',
    ].join('\n'),
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.layout.style, 'columns');
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows[3]?.segments, [
    'Top Group',
    'Secondary Group',
    'Lower Level Group 2',
  ]);
});

test('Level headers name the columns explicitly', () => {
  const r = parseGroupCsv('Level 1,Level 2\nFinance,Procure to Pay');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0]?.segments, ['Finance', 'Procure to Pay']);
});

test('a gap in the middle of a path is rejected, not guessed at', () => {
  // The outline style, where blank parents mean "same as the row above". Deleting or
  // sorting a row silently reparents everything below it, so we do not accept it.
  const r = parseGroupCsv('Level 1,Level 2,Level 3\nTop,,Lower');
  assert.equal(r.rows.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.message, /empty level 2/);
  assert.match(r.errors[0]!.message, /full path on every row/);
});

test('trailing empty columns just mean the path stops there', () => {
  const r = parseGroupCsv('Level 1,Level 2,Level 3\nTop,,');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0]?.segments, ['Top']);
});

test('a pipe inside a level name is a warning, not a level break', () => {
  // Almost always a file half-converted from the single-column format, but "|" is a
  // legal character in a name once columns carry the nesting.
  const r = parseGroupCsv('Level 1,Level 2\nFinance,Procure | Pay');
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.rows[0]?.segments, ['Finance', 'Procure | Pay']);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /part of the name/);
});

test('data past the last header column is an error, not silently dropped', () => {
  const r = parseGroupCsv('Level 1,Level 2\nTop,Second,Third');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.message, /more columns filled in/);
});

test('a single-column file still rejects commas, and now says how to use them', () => {
  const r = parseGroupCsv('Group Path\nTop Group,Secondary Group');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.message, /separated by "\|"/);
  assert.match(r.errors[0]!.message, /"Level 1", "Level 2"/);
});

// ------------------------------------------------------------ group ids

const ID_A = 'aaaaaaaa-1111-2222-3333-444444444444';
const ID_B = 'bbbbbbbb-1111-2222-3333-444444444444';

test('a group id is read alongside the path', () => {
  const r = parseGroupCsv(`Group Unique Id,Level 1,Level 2\n${ID_A},Finance,Procure to Pay`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0]?.uniqueId, ID_A);
  assert.deepEqual(r.rows[0]?.segments, ['Finance', 'Procure to Pay']);
});

test('a blank id means "create this by name", which is the hand-typed case', () => {
  const r = parseGroupCsv(`Group Unique Id,Level 1\n,Brand New Group`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows[0]?.uniqueId, null);
});

test('an id column works with the single-path column too', () => {
  const r = parseGroupCsv(`Group Unique Id,Group Path\n${ID_A},Finance | Procure to Pay`);
  assert.deepEqual(r.errors, []);
  assert.equal(r.layout.style, 'path');
  assert.deepEqual(r.rows[0]?.segments, ['Finance', 'Procure to Pay']);
  assert.equal(r.rows[0]?.uniqueId, ID_A);
});

test('something that is not an id is rejected rather than read as "no id"', () => {
  // Treating it as blank would quietly turn "this exact group" into "whatever is
  // named that", which is the failure the column exists to prevent.
  const r = parseGroupCsv('Group Unique Id,Level 1\n814,Finance');
  assert.equal(r.rows.length, 0);
  assert.match(r.errors[0]!.message, /is not a group id/);
});

test('the same id twice is an error', () => {
  const r = parseGroupCsv(
    `Group Unique Id,Level 1\n${ID_A},Finance\n${ID_A},Finance Renamed`,
  );
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0]!.message, /both carry group id/);
});

test('two different groups sharing a path are both kept, with a warning', () => {
  // The tenant really does contain these. Neither row is wrong, but the path no longer
  // picks one out, so anything nested below it is stuck.
  const r = parseGroupCsv(
    `Group Unique Id,Level 1,Level 2\n${ID_A},Crestan,Finance\n${ID_B},Crestan,Finance`,
  );
  assert.deepEqual(r.errors, []);
  assert.equal(r.rows.length, 2);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0]!.message, /two different groups/);
});
