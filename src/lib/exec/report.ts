/**
 * The record of what happened, for whoever has to answer for it later.
 *
 * Built in the browser from the run's outcomes and downloaded directly — it never
 * transits our server, which is the same reason the plan is generated client-side.
 *
 * The rule it exists to enforce: skipped work is never something the operator has to
 * go looking for. Rows the planner refused before the run started have no outcome of
 * their own, so they are given one here — otherwise a partially-applied file reports
 * as a clean success, which is the single most misleading thing this tool could say.
 */

import { toCsv } from '../csv/parse.ts';
import type { GroupPlan } from '../plan/groupPlan.ts';
import type { ShortcutPlan } from '../plan/shortcutPlan.ts';
import type { Outcome } from './runner.ts';

export interface ReportInput {
  outcomes: readonly Outcome[];
  /** Rows the planner refused. They belong in the report as much as the rest. */
  groupPlan?: GroupPlan | null | undefined;
  shortcutPlan?: ShortcutPlan | null | undefined;
}

export interface ReportSummary {
  ok: number;
  skipped: number;
  failed: number;
  /** Refused before the run, so never attempted. */
  blocked: number;
  total: number;
}

/**
 * Plan-level refusals, in the same shape as everything the runner produced.
 *
 * One representation means the screen and the CSV cannot drift apart on what counts
 * as a problem.
 */
export function blockedOutcomes(input: ReportInput): Outcome[] {
  const out: Outcome[] = [];

  for (const issue of input.groupPlan?.blocked ?? []) {
    out.push({
      type: 'group',
      target: issue.display,
      targetId: null,
      action: 'create',
      result: 'blocked',
      before: '',
      after: '',
      detail: issue.message,
      line: issue.line,
    });
  }

  for (const issue of input.shortcutPlan?.blocked ?? []) {
    out.push({
      type: 'process',
      target: issue.processName,
      targetId: issue.processUniqueId,
      action: 'shortcuts.update',
      result: 'blocked',
      before: '',
      after: '',
      detail: issue.reason,
      line: issue.line,
    });
  }

  return out;
}

/** Everything the file asked for, attempted or not. */
export function allRows(input: ReportInput): Outcome[] {
  return [...input.outcomes, ...blockedOutcomes(input)];
}

export function summarise(input: ReportInput): ReportSummary {
  const counts = { ok: 0, skipped: 0, failed: 0, blocked: 0 };
  for (const row of allRows(input)) counts[row.result]++;
  return { ...counts, total: counts.ok + counts.skipped + counts.failed + counts.blocked };
}

const HEADER = [
  'Type',
  'Target',
  'Target Id',
  'Action',
  'Result',
  'Version Before',
  'Version After (expected)',
  'Detail',
  'CSV Row',
] as const;

export function reportToCsv(input: ReportInput): string {
  const rows: string[][] = [[...HEADER]];

  for (const row of allRows(input)) {
    rows.push([
      row.type,
      row.target,
      row.targetId ?? '',
      row.action,
      row.result,
      row.before,
      row.after,
      row.detail,
      row.line === null ? '' : String(row.line),
    ]);
  }

  return toCsv(rows);
}

/** Everything that did not simply work — what someone actually needs to read. */
export function needsAttention(input: ReportInput): Outcome[] {
  return allRows(input).filter((row) => row.result !== 'ok');
}
