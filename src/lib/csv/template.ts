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
 * The shortcut upload format: one row per (process, group) pair.
 *
 * `Process Unique Id` is named to match Process Manager's own Process List export, so
 * a column copied from the site drops straight in. `Group Unique Id` is the same
 * column the group hierarchy download emits — that file is the lookup table for this
 * one, which is why the two agree on the name.
 */
export const SHORTCUT_HEADER = [
  'Process Unique Id',
  'Process Name',
  'Group Unique Id',
  'Action',
] as const;

/**
 * The same file with the operator's bearings added.
 *
 * `Current Group` and `Current Shortcuts` are ignored on upload. They exist so that
 * someone editing a 1,518-row sheet can see what a process already has without
 * cross-referencing a second file — the ids are unreadable, and a shortcut file whose
 * rows cannot be sanity-checked by eye is one nobody can review.
 */
export const SHORTCUT_WORKSHEET_HEADER = [
  'Process Unique Id',
  'Process Name',
  'Current Group',
  'Current Shortcuts',
  'Group Unique Id',
  'Action',
] as const;

export function shortcutHeader(): string[] {
  return [...SHORTCUT_HEADER];
}

export function shortcutWorksheetHeader(): string[] {
  return [...SHORTCUT_WORKSHEET_HEADER];
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
  /** The process's current shortcuts. */
  shortcuts: ReadonlyArray<{ uniqueId: string; display: string }>;
}

const SHORTCUT_LIST_JOIN = '; ';

/**
 * Blank shortcut template.
 *
 * Two rows for one process, because that is the part of the format people get wrong:
 * a process wanting three shortcuts gets three rows, not three columns.
 */
export function shortcutTemplate(): string {
  const header = shortcutHeader();
  const process = '00000000-0000-0000-0000-000000000000';
  return toCsv([
    header,
    [process, 'Example process, replace this row', '11111111-1111-1111-1111-111111111111', 'Add'],
    [process, 'Example process, replace this row', '22222222-2222-2222-2222-222222222222', 'Add'],
    [process, 'Example process, replace this row', '33333333-3333-3333-3333-333333333333', 'Remove'],
  ]);
}

/**
 * Current state for a set of processes, as rows that re-apply what is already there.
 *
 * Every row is an `Add` of a shortcut the process already has, so an untouched export
 * round-trips to no change at all. A process with no shortcuts still gets a row, with
 * an empty group, so the file lists every process the operator might want to edit
 * rather than only the ones already shortcut somewhere.
 */
export function shortcutExport(rows: readonly ShortcutExportRow[]): string {
  const header = shortcutWorksheetHeader();
  const body: string[][] = [];

  for (const row of rows) {
    const current = row.shortcuts.map((s) => s.display).join(SHORTCUT_LIST_JOIN);
    if (row.shortcuts.length === 0) {
      body.push([row.processUniqueId, row.processName, row.currentGroup, '', '', '']);
      continue;
    }
    for (const shortcut of row.shortcuts) {
      body.push([
        row.processUniqueId,
        row.processName,
        row.currentGroup,
        current,
        shortcut.uniqueId,
        'Add',
      ]);
    }
  }

  return toCsv([header, ...body]);
}

function pad(cells: readonly string[], width: number): string[] {
  const out = [...cells];
  while (out.length < width) out.push('');
  return out;
}
