/**
 * Working out how a group-structure CSV is laid out.
 *
 * Two shapes are accepted, and the header row is what tells them apart:
 *
 *   path      one column holding a whole `A | B | C` path. The original format.
 *   columns   one column per level — `A,B,C`. What Excel users reach for, and what
 *             an export produces.
 *
 * Either may be preceded by a `Group Unique Id` column, which pins a row to a
 * specific group rather than to whatever currently answers to that name.
 *
 * The layout is decided by the *header*, never by the widest data row. That matters:
 * in a single-column file a row with three cells is someone typing commas where they
 * meant pipes, and we still want to catch it rather than silently reinterpret the file.
 */

/**
 * The id column's canonical name. Blank in a cell means "create a group with this
 * name"; filled means "this exact group", which is the only way to address one of two
 * siblings that share a name.
 */
export const GROUP_ID_HEADER = 'Group Unique Id';

/** Accepted spellings of the id column. */
const ID_HEADER = /^(group\s*unique\s*id|group\s*id|unique\s*id)$/i;

/** Accepted spellings of a level column. `Group Path` heads the leftmost one. */
const PATH_HEADER = /^(group\s*path|path)$/i;
const LEVEL_HEADER = /^level\s*\d+$/i;

export interface GroupCsvLayout {
  /** Column holding the group id, or null when the file carries no ids. */
  idColumn: number | null;
  /** Columns holding names, outermost first. Never empty. */
  nameColumns: number[];
  /** Whether row 1 is a header and must be skipped. */
  hasHeader: boolean;
  style: 'path' | 'columns';
}

/**
 * True when every populated cell in the row is a column name we recognise.
 *
 * Conservative on purpose. A file of bare paths is valid and has no header at all, so
 * anything unrecognised has to be read as data — the cost of guessing wrong here is
 * silently dropping the operator's first group.
 */
export function isGroupHeaderRow(cells: readonly string[]): boolean {
  let recognised = 0;
  for (const cell of cells) {
    const text = cell.trim();
    if (text === '') continue;
    if (ID_HEADER.test(text) || PATH_HEADER.test(text) || LEVEL_HEADER.test(text)) {
      recognised += 1;
      continue;
    }
    return false;
  }
  return recognised > 0;
}

export function detectGroupLayout(grid: readonly (readonly string[])[]): GroupCsvLayout {
  const header = grid[0];

  if (header && isGroupHeaderRow(header)) {
    const idColumn = header.findIndex((cell) => ID_HEADER.test(cell.trim()));
    const nameColumns = header.map((_, i) => i).filter((i) => i !== idColumn);

    // A file of nothing but an id column has no names to read; fall back to treating
    // the remaining column as a path so the parser can report the row properly.
    if (nameColumns.length === 0) {
      return { idColumn: null, nameColumns: [0], hasHeader: true, style: 'path' };
    }

    return {
      idColumn: idColumn === -1 ? null : idColumn,
      nameColumns,
      hasHeader: true,
      // Trailing blank header cells count. "Group Path,," is what Excel writes when
      // someone splits the old template across columns without renaming the headers,
      // and it is unambiguously the wide shape.
      style: nameColumns.length > 1 ? 'columns' : 'path',
    };
  }

  return { idColumn: null, nameColumns: [0], hasHeader: false, style: 'path' };
}
