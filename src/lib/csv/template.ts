/**
 * Template and current-state CSV generation.
 *
 * Templates get someone started; exports are the recommended route, because a row
 * exported with its existing shortcuts round-trips to a no-op rather than a change.
 * That is what makes replace semantics safe for a partially-edited spreadsheet.
 */

import { displayPath } from './path.ts';
import { toCsv } from './parse.ts';

export const GROUP_HEADER = ['Group Path'] as const;

export const SHORTCUT_BASE_HEADER = ['Process ID', 'Process Name', 'Current Group'] as const;

/** Default number of Shortcut columns in a generated file. Not a limit — see PLAN.md §4.3. */
export const DEFAULT_SHORTCUT_COLUMNS = 5;

export function shortcutHeader(columns = DEFAULT_SHORTCUT_COLUMNS): string[] {
  return [
    ...SHORTCUT_BASE_HEADER,
    ...Array.from({ length: columns }, (_, i) => `Shortcut ${i + 1}`),
  ];
}

/** Blank group-structure template with illustrative rows. */
export function groupTemplate(): string {
  return toCsv([
    [...GROUP_HEADER],
    ['Top Group'],
    ['Top Group | Secondary Group'],
    ['Top Group | Secondary Group | Lower Level Group 1'],
    ['Top Group | Secondary Group | Lower Level Group 2'],
  ]);
}

/** Every existing group path, newest structure first as the tree reports it. */
export function groupExport(paths: readonly (readonly string[])[]): string {
  return toCsv([[...GROUP_HEADER], ...paths.map((p) => [displayPath(p)])]);
}

export interface ShortcutExportRow {
  processUniqueId: string;
  processName: string;
  /** Full path of the process's home group. */
  currentGroup: string;
  /** Full paths of the process's current shortcuts. */
  shortcuts: string[];
}

/** Blank shortcut template. */
export function shortcutTemplate(columns = DEFAULT_SHORTCUT_COLUMNS): string {
  const width = shortcutHeader(columns).length;
  const example = [
    '00000000-0000-0000-0000-000000000000',
    'Example process — replace this row',
    'Existing | Home Group',
    'Top Group | Secondary Group',
  ];
  return toCsv([shortcutHeader(columns), pad(example, width)]);
}

/**
 * Current state for a set of processes.
 *
 * The file is always wide enough for the process with the most shortcuts, so an
 * export never truncates what it is describing.
 */
export function shortcutExport(
  rows: readonly ShortcutExportRow[],
  minColumns = DEFAULT_SHORTCUT_COLUMNS,
): string {
  const widest = rows.reduce((n, r) => Math.max(n, r.shortcuts.length), 0);
  const columns = Math.max(minColumns, widest);
  const header = shortcutHeader(columns);

  const body = rows.map((r) =>
    pad([r.processUniqueId, r.processName, r.currentGroup, ...r.shortcuts], header.length),
  );

  return toCsv([header, ...body]);
}

function pad(cells: readonly string[], width: number): string[] {
  const out = [...cells];
  while (out.length < width) out.push('');
  return out;
}
