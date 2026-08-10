/**
 * Template and current-state CSV generation.
 *
 * Templates get someone started; exports are the recommended route, because a row
 * exported with its existing shortcuts round-trips to a no-op rather than a change.
 * That is what makes replace semantics safe for a partially-edited spreadsheet.
 */

import { GROUP_ID_HEADER } from './layout.ts';
import { toCsv } from './parse.ts';

export { GROUP_ID_HEADER } from './layout.ts';

/**
 * Level columns are always at least this wide, so a generated file is unambiguously
 * the one-column-per-level shape rather than a single path column.
 */
const MIN_GROUP_LEVELS = 3;

export function groupHeader(levels = MIN_GROUP_LEVELS): string[] {
  const width = Math.max(MIN_GROUP_LEVELS, levels);
  return [GROUP_ID_HEADER, ...Array.from({ length: width }, (_, i) => `Level ${i + 1}`)];
}

/**
 * Named to match Process Manager's own Process List export, so a file downloaded
 * from the site and a file generated here are interchangeable.
 */
export const SHORTCUT_BASE_HEADER = [
  'Process Unique Id',
  'Process Name',
  'Current Group',
] as const;

/** Default number of Shortcut columns in a generated file. Not a limit — see PLAN.md §4.3. */
export const DEFAULT_SHORTCUT_COLUMNS = 5;

export function shortcutHeader(columns = DEFAULT_SHORTCUT_COLUMNS): string[] {
  return [
    ...SHORTCUT_BASE_HEADER,
    ...Array.from({ length: columns }, (_, i) => `Shortcut ${i + 1}`),
  ];
}

/**
 * Blank group-structure template.
 *
 * Every row spells out its whole path rather than relying on the row above. That is
 * more typing, but a row can then be moved, sorted, or deleted without silently
 * reparenting everything beneath it.
 */
export function groupTemplate(): string {
  const header = groupHeader();
  return toCsv([
    header,
    pad(['', 'Top Group'], header.length),
    pad(['', 'Top Group', 'Secondary Group'], header.length),
    pad(['', 'Top Group', 'Secondary Group', 'Lower Level Group 1'], header.length),
    pad(['', 'Top Group', 'Secondary Group', 'Lower Level Group 2'], header.length),
  ]);
}

export interface GroupExportRow {
  uniqueId: string;
  path: readonly string[];
}

/**
 * Every existing group, in tree order, one level per column.
 *
 * The ids are what make this file safe to edit and send back: a row that keeps its id
 * refers to that group whatever its name, so re-uploading an untouched export is a
 * no-op even where two groups share a name.
 */
export function groupExport(groups: readonly GroupExportRow[]): string {
  const deepest = groups.reduce((n, g) => Math.max(n, g.path.length), 0);
  const header = groupHeader(deepest);
  const body = groups.map((g) => pad([g.uniqueId, ...g.path], header.length));
  return toCsv([header, ...body]);
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
