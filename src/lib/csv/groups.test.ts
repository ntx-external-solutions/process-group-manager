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
