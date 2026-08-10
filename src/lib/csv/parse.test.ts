import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isBlankRow, parseCsv, toCsv } from './parse.ts';

test('parses a simple grid', () => {
  assert.deepEqual(parseCsv('a,b\nc,d'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('handles CRLF, which is what Excel writes', () => {
  assert.deepEqual(parseCsv('a,b\r\nc,d\r\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
});

test('strips a UTF-8 BOM', () => {
  // Excel prefixes exported CSVs with a BOM; unstripped it corrupts the first header.
  assert.deepEqual(parseCsv('﻿Process ID,Process Name\n1,x'), [
    ['Process ID', 'Process Name'],
    ['1', 'x'],
  ]);
});

test('a trailing newline does not produce a phantom row', () => {
  assert.equal(parseCsv('a\nb\n').length, 2);
});

test('quoted fields keep their commas', () => {
  assert.deepEqual(parseCsv('"Go To Market (Sales, Marketing)",x'), [
    ['Go To Market (Sales, Marketing)', 'x'],
  ]);
});

test('doubled quotes unescape to one quote', () => {
  assert.deepEqual(parseCsv('"She said ""hi""",x'), [['She said "hi"', 'x']]);
});

test('quoted fields may contain newlines', () => {
  assert.deepEqual(parseCsv('"line one\nline two",x'), [['line one\nline two', 'x']]);
});

test('an empty quoted field survives as a present-but-empty cell', () => {
  // Matters for shortcut columns: "" is a cell the author left blank, and the row
  // must not silently lose a column position.
  assert.deepEqual(parseCsv('a,"",c'), [['a', '', 'c']]);
});

test('ragged rows are preserved, not padded', () => {
  assert.deepEqual(parseCsv('a,b,c\nd,e'), [
    ['a', 'b', 'c'],
    ['d', 'e'],
  ]);
});

test('isBlankRow catches whitespace-only rows', () => {
  assert.equal(isBlankRow(['', '  ', '']), true);
  assert.equal(isBlankRow(['', 'x']), false);
});

test('toCsv round-trips through parseCsv', () => {
  const rows = [
    ['Group Path'],
    ['Go To Market (Sales, Marketing) | Marketing'],
    ['Quote " inside'],
  ];
  assert.deepEqual(parseCsv(toCsv(rows)), rows);
});
