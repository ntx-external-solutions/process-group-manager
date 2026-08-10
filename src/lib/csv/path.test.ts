import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ancestorsOf,
  createName,
  displayPath,
  isAddressableGroupName,
  matchKey,
  parsePath,
  pathKey,
} from './path.ts';

// Names below are taken verbatim from the live tenant. They look like typos because
// they are typos — they are also production data we must interoperate with.

test('matchKey collapses the differences we choose to ignore', () => {
  assert.equal(matchKey('Partner Facing '), 'partner facing');
  assert.equal(matchKey('  Partner   Facing  '), 'partner facing');
  assert.equal(matchKey('PARTNER FACING'), 'partner facing');
  assert.equal(matchKey('Finance & IT'), 'finance & it');
});

test('createName preserves everything except outer whitespace', () => {
  assert.equal(createName('  Sales Operations  '), 'Sales Operations');
  // Internal spacing is the author's business, not ours.
  assert.equal(createName('Deliver  Client   Engagement'), 'Deliver  Client   Engagement');
  assert.equal(createName('GL Strategic Sales'), 'GL Strategic Sales');
});

test('a trailing-space group matches without being recreated or renamed', () => {
  // The whole point of the match/create split: "Partner Facing " already exists,
  // so a CSV saying "Partner Facing" must resolve to it...
  assert.equal(matchKey('Partner Facing'), matchKey('Partner Facing '));
  // ...but if we ever do create it, we must not invent the trailing space back.
  assert.notEqual(createName('Partner Facing'), 'Partner Facing ');
});

test('parsePath splits on the separator and trims each level', () => {
  const r = parsePath('Go To Market (Sales and Marketing) | Marketing | Campaigns');
  assert.ok(r.ok);
  assert.deepEqual(r.value, [
    'Go To Market (Sales and Marketing)',
    'Marketing',
    'Campaigns',
  ]);
});

test('parsePath accepts a single top-level group', () => {
  const r = parsePath('Top Group');
  assert.ok(r.ok);
  assert.deepEqual(r.value, ['Top Group']);
});

test('parsePath rejects empty levels rather than guessing', () => {
  for (const bad of ['A || B', '| A', 'A |', '  |  ']) {
    const r = parsePath(bad);
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('parsePath rejects an empty cell', () => {
  const r = parsePath('   ');
  assert.ok(!r.ok);
  assert.match(r.error, /empty/i);
});

test('parsePath error names the offending position', () => {
  const r = parsePath('Top || Lower');
  assert.ok(!r.ok);
  assert.match(r.error, /position 2/);
});

test('pathKey distinguishes same-named groups under different parents', () => {
  // "Operations" exists under both Professional Services and elsewhere; full-path
  // keying is what keeps them apart.
  const a = pathKey(['Professional Services', 'Operations']);
  const b = pathKey(['Finance & IT', 'Operations']);
  assert.notEqual(a, b);
});

test('pathKey is stable across casing and spacing noise', () => {
  assert.equal(
    pathKey(['Professional Services', 'Operations']),
    pathKey(['  professional   services ', 'OPERATIONS']),
  );
});

test('pathKey does not let segment boundaries blur together', () => {
  // ["A B", "C"] and ["A", "B C"] must not collide.
  assert.notEqual(pathKey(['A B', 'C']), pathKey(['A', 'B C']));
});

test('group names containing the separator are flagged as unaddressable', () => {
  assert.equal(isAddressableGroupName('Sales'), true);
  assert.equal(isAddressableGroupName('Sales | Marketing'), false);
});

test('displayPath round-trips a parsed path', () => {
  const raw = 'Top Group | Secondary Group | Lower Level Group 1';
  const r = parsePath(raw);
  assert.ok(r.ok);
  assert.equal(displayPath(r.value), raw);
});

test('ancestorsOf lists proper ancestors outermost first', () => {
  assert.deepEqual(ancestorsOf(['A', 'B', 'C']), [['A'], ['A', 'B']]);
  assert.deepEqual(ancestorsOf(['A']), []);
});
