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

/** The group's primary champion, by logon. */
export const CHAMPION_HEADER = 'Champion';
/** `Region: logon` pairs, separated by semicolons. */
export const REGIONAL_CHAMPION_HEADER = 'Regional Champions';

/** Accepted spellings of the id column. */
const ID_HEADER = /^(group\s*unique\s*id|group\s*id|unique\s*id)$/i;

/** Accepted spellings of a level column. `Group Path` heads the leftmost one. */
const PATH_HEADER = /^(group\s*path|path)$/i;
const LEVEL_HEADER = /^level\s*\d+$/i;

/**
 * The champion columns.
 *
 * Both are optional, and both have to be recognised here rather than only where they are
 * read: an unrecognised header cell makes `isGroupHeaderRow` reject the whole row, and a
 * file with no header is parsed as bare paths — so adding a `Champion` column to a file
 * without teaching this function about it would turn the header itself into a group.
 */
const CHAMPION_COLUMN = /^(primary\s*)?champion$/i;
const REGIONAL_CHAMPION_COLUMN = /^regional\s*champions?$/i;

export interface GroupCsvLayout {
  /** Column holding the group id, or null when the file carries no ids. */
  idColumn: number | null;
  /** Column holding the primary champion's logon, or null when the file has none. */
  championColumn: number | null;
  /** Column holding `Region: logon` pairs, or null when the file has none. */
  regionalChampionColumn: number | null;
  /** Columns holding names, outermost first. Never empty. */
  nameColumns: number[];
  /** Whether row 1 is a header and must be skipped. */
  hasHeader: boolean;
  style: 'path' | 'columns';
}

/** True when the file asks for champions at all, and so needs the directory. */
export function hasChampionColumns(layout: GroupCsvLayout): boolean {
  return layout.championColumn !== null || layout.regionalChampionColumn !== null;
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
    if (
      ID_HEADER.test(text) ||
      PATH_HEADER.test(text) ||
      LEVEL_HEADER.test(text) ||
      CHAMPION_COLUMN.test(text) ||
      REGIONAL_CHAMPION_COLUMN.test(text)
    ) {
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
    const find = (pattern: RegExp): number | null => {
      const index = header.findIndex((cell) => pattern.test(cell.trim()));
      return index === -1 ? null : index;
    };

    const idColumn = find(ID_HEADER);
    const championColumn = find(CHAMPION_COLUMN);
    const regionalChampionColumn = find(REGIONAL_CHAMPION_COLUMN);

    // Everything that is not one of the named columns holds a level. Blank headers
    // included — see the note on `style` below.
    const reserved = new Set([idColumn, championColumn, regionalChampionColumn]);
    const nameColumns = header.map((_, i) => i).filter((i) => !reserved.has(i));

    // A file of nothing but named columns has no names to read; fall back to treating
    // the first column as a path so the parser can report the row properly.
    if (nameColumns.length === 0) {
      return {
        idColumn: null,
        championColumn,
        regionalChampionColumn,
        nameColumns: [0],
        hasHeader: true,
        style: 'path',
      };
    }

    return {
      idColumn,
      championColumn,
      regionalChampionColumn,
      nameColumns,
      hasHeader: true,
      // Trailing blank header cells count. "Group Path,," is what Excel writes when
      // someone splits the old template across columns without renaming the headers,
      // and it is unambiguously the wide shape.
      style: nameColumns.length > 1 ? 'columns' : 'path',
    };
  }

  return {
    idColumn: null,
    championColumn: null,
    regionalChampionColumn: null,
    nameColumns: [0],
    hasHeader: false,
    style: 'path',
  };
}
