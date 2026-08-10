import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv } from '../csv/parse.ts';
import { needsAttention, reportToCsv, summarise } from './report.ts';
import type { Outcome } from './runner.ts';

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    type: 'process',
    target: 'PQL via BDR',
    targetId: '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c',
    action: 'shortcuts.update',
    result: 'ok',
    before: '2.3',
    after: '3.0',
    detail: 'Published.',
    line: 2,
    ...over,
  };
}

test('counts are split by what actually happened', () => {
  const summary = summarise({
    outcomes: [
      outcome(),
      outcome({ result: 'skipped' }),
      outcome({ result: 'failed' }),
      outcome({ result: 'failed' }),
    ],
  });

  assert.deepEqual(summary, { ok: 1, skipped: 1, failed: 2, blocked: 0, total: 4 });
});

test('rows blocked before the run are counted, not quietly dropped', () => {
  // They never reached the runner, so they have no outcome — but a total that omits
  // them makes a partially-applied file look complete.
  const summary = summarise({
    outcomes: [outcome()],
    shortcutPlan: {
      updates: [],
      clears: [],
      unchanged: [],
      warnings: [],
      blocked: [
        { line: 4, processUniqueId: 'x', processName: 'Awaiting', reason: 'Awaiting approval — not modified.' },
      ],
    },
  });

  assert.equal(summary.blocked, 1);
  assert.equal(summary.total, 2);
});

test('the CSV carries the reason a row was skipped', () => {
  const csv = reportToCsv({
    outcomes: [
      outcome({ result: 'skipped', detail: 'Changed by someone else since the preview was taken.' }),
    ],
  });

  const grid = parseCsv(csv);
  assert.deepEqual(grid[0]?.slice(0, 5), ['Type', 'Target', 'Target Id', 'Action', 'Result']);
  assert.equal((grid[1] as string[])[4], 'skipped');
  assert.match((grid[1] as string[])[7] as string, /Changed by someone else/);
});

test('blocked rows appear in the CSV alongside what was attempted', () => {
  const csv = reportToCsv({
    outcomes: [outcome()],
    groupPlan: {
      creates: [],
      renames: [],
      moves: [],
      existing: [],
      blocked: [{ line: 5, display: 'Bad | Path', message: 'Matches 2 existing groups.' }],
    },
  });

  const grid = parseCsv(csv);
  assert.equal(grid.length, 3, 'header, one outcome, one blocked row');
  // "group", not "create": the planner refuses a row before deciding whether it would
  // have created, renamed, or moved anything.
  assert.deepEqual((grid[2] as string[]).slice(0, 5), ['group', 'Bad | Path', '', 'group', 'blocked']);
});

test('the version column is labelled as expected, not as observed', () => {
  // The API returns a revision id on write, never a version string.
  const grid = parseCsv(reportToCsv({ outcomes: [outcome()] }));
  assert.equal(grid[0]?.[6], 'Version After (expected)');
});

test('needsAttention is everything that did not simply work', () => {
  const rows = needsAttention({
    outcomes: [outcome(), outcome({ result: 'failed' }), outcome({ result: 'skipped' })],
  });
  assert.deepEqual(rows.map((r) => r.result), ['failed', 'skipped']);
});

test('a row blocked before the run still needs attention', () => {
  // Otherwise the screen reports "everything applied" beside a count of blocked rows,
  // which is the one thing this report exists not to do.
  const rows = needsAttention({
    outcomes: [outcome()],
    shortcutPlan: {
      updates: [],
      clears: [],
      unchanged: [],
      warnings: [],
      blocked: [
        {
          line: 5,
          processUniqueId: 'x',
          processName: 'Awaiting approval',
          reason: 'Awaiting approval — not modified.',
        },
      ],
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.result, 'blocked');
  assert.match(rows[0]?.detail as string, /Awaiting approval/);
});
