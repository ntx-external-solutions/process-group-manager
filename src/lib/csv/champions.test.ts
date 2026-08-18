import assert from 'node:assert/strict';
import { test } from 'node:test';

import { needsDirectory, parseChampionCell, parseRegionalCell } from './champions.ts';
import { parseGroupCsv } from './groups.ts';
import { detectGroupLayout, hasChampionColumns } from './layout.ts';
import { parseCsv } from './parse.ts';

// ------------------------------------------------------------------ cells

test('a blank champion cell leaves the group alone', () => {
  // The distinction the whole column rests on: blank is not an instruction.
  assert.deepEqual(parseChampionCell(''), { ok: true, value: null });
  assert.deepEqual(parseChampionCell('   '), { ok: true, value: null });
  assert.deepEqual(parseRegionalCell(''), { ok: true, value: null });
});

test('CLEAR removes, in either case', () => {
  assert.deepEqual(parseChampionCell('CLEAR'), { ok: true, value: 'clear' });
  assert.deepEqual(parseChampionCell(' clear '), { ok: true, value: 'clear' });
  assert.deepEqual(parseRegionalCell('Clear'), { ok: true, value: 'clear' });
});

test('a champion is one logon, and two is an error rather than the first', () => {
  assert.deepEqual(parseChampionCell(' jonathan@palouse.io '), {
    ok: true,
    value: 'jonathan@palouse.io',
  });

  const two = parseChampionCell('a@x.io; b@x.io');
  assert.equal(two.ok, false);
  assert.match(two.ok ? '' : two.error, /one champion/);
});

test('a region in the champion column is refused rather than parsed as a logon', () => {
  const result = parseChampionCell('AET: someone@x.io');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /regional champion/i);
});

test('regional pairs split on the first colon, so logons with dots and @ survive', () => {
  const result = parseRegionalCell('AET: bohdan.pavlenko@nintex.com; EMEA:hugo');
  assert.deepEqual(result, {
    ok: true,
    value: [
      { region: 'AET', logon: 'bohdan.pavlenko@nintex.com' },
      { region: 'EMEA', logon: 'hugo' },
    ],
  });
});

test('several champions in one region are normal', () => {
  const result = parseRegionalCell('AET: one@x.io; AET: two@x.io');
  assert.equal(result.ok && result.value !== 'clear' && result.value !== null && result.value.length, 2);
});

test('the same person twice in one region is a copy-paste artefact, not two instructions', () => {
  const result = parseRegionalCell('AET: one@x.io; aet: ONE@X.IO');
  assert.equal(result.ok && result.value !== 'clear' && result.value !== null && result.value.length, 1);
});

test('a regional entry with no region is refused', () => {
  const result = parseRegionalCell('someone@x.io');
  assert.equal(result.ok, false);
  assert.match(result.ok ? '' : result.error, /which region/);
});

// ----------------------------------------------------------------- layout

test('a champion column does not stop the header being recognised', () => {
  // Without this the header row parses as data and becomes a group called "Level 1".
  const grid = parseCsv('Group Unique Id,Level 1,Level 2,Champion,Regional Champions\n,A,B,x@y.io,');
  const layout = detectGroupLayout(grid);

  assert.equal(layout.hasHeader, true);
  assert.equal(layout.style, 'columns');
  assert.deepEqual(layout.nameColumns, [1, 2]);
  assert.equal(layout.championColumn, 3);
  assert.equal(layout.regionalChampionColumn, 4);
  assert.equal(hasChampionColumns(layout), true);
});

test('a file without the columns reports none, so nothing asks for a SCIM key', () => {
  const layout = detectGroupLayout(parseCsv('Group Unique Id,Level 1\n,A'));
  assert.equal(hasChampionColumns(layout), false);
});

// -------------------------------------------------------------- whole file

test('champion cells ride on the row, and the path is unaffected', () => {
  const parsed = parseGroupCsv(
    'Level 1,Level 2,Champion,Regional Champions\n' +
      'Legal,Compliance,jonathan@palouse.io,"AET: a@x.io; EMEA: b@x.io"\n' +
      'Legal,Risk,,\n',
  );

  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows[0]?.segments, ['Legal', 'Compliance']);
  assert.equal(parsed.rows[0]?.champion, 'jonathan@palouse.io');
  assert.equal(
    parsed.rows[0]?.regionalChampions !== 'clear' && parsed.rows[0]?.regionalChampions?.length,
    2,
  );
  assert.equal(parsed.rows[1]?.champion, null);
  assert.equal(parsed.rows[1]?.regionalChampions, null);
});

test('a champion cell that cannot be read stops its row rather than being dropped', () => {
  // Silently ignoring it would create the group and quietly not grant the access.
  const parsed = parseGroupCsv('Level 1,Regional Champions\nLegal,someone@x.io\n');
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0]?.message ?? '', /Row 2/);
});

test('champion columns are not mistaken for a level that has overflowed', () => {
  const parsed = parseGroupCsv('Group Unique Id,Level 1,Champion\n,Legal,x@y.io\n');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.rows[0]?.segments, ['Legal']);
});

// ------------------------------------------------------- when a key is needed

test('an untouched export needs no SCIM key, columns or not', () => {
  // Every generated file carries the columns now, so asking on the columns alone would
  // block an ordinary group upload behind a credential, to look up nothing.
  const parsed = parseGroupCsv(
    'Group Unique Id,Level 1,Champion,Regional Champions\n,Legal,,\n,Risk,,\n',
  );
  assert.deepEqual(parsed.errors, []);
  assert.equal(needsDirectory(parsed.rows), false);
});

test('removing a champion needs no key either — CLEAR names nobody', () => {
  const parsed = parseGroupCsv('Level 1,Champion\nLegal,CLEAR\n');
  assert.equal(needsDirectory(parsed.rows), false);
});

test('a named logon is what needs the directory', () => {
  assert.equal(
    needsDirectory(parseGroupCsv('Level 1,Champion\nLegal,jonathan@palouse.io\n').rows),
    true,
  );
  assert.equal(
    needsDirectory(
      parseGroupCsv('Level 1,Regional Champions\nLegal,"AET: jonathan@palouse.io"\n').rows,
    ),
    true,
  );
});
