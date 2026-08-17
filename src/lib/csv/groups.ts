/**
 * Group-structure CSV.
 *
 * Two layouts, decided by the header (see layout.ts): one full `A | B | C` path per
 * row, or one column per level. Either may carry a `Group Unique Id` column, which
 * names the exact group a row refers to instead of relying on it having a unique name.
 *
 * Every message here is read by someone who is not a developer, so errors name the
 * row number and say what to do, not what went wrong internally.
 */

import {
  parseChampionCell,
  parseRegionalCell,
  type ChampionCell,
  type RegionalCell,
} from './champions.ts';
import { detectGroupLayout, type GroupCsvLayout } from './layout.ts';
import { isBlankRow, parseCsv } from './parse.ts';
import {
  createName,
  displayPath,
  parseGroupId,
  parsePath,
  pathKey,
  PATH_SEPARATOR,
} from './path.ts';

export interface CsvIssue {
  /** 1-based line number as the operator sees it in Excel. */
  line: number;
  message: string;
}

export interface GroupCsvRow {
  line: number;
  segments: string[];
  display: string;
  /**
   * The group this row refers to, when the operator supplied an id. Null means
   * "whichever group has this path", which is the original behaviour and still the
   * right one for rows someone typed by hand.
   */
  uniqueId: string | null;
  /**
   * The primary champion this row asks for. `null` means the cell was blank, which
   * leaves the group's champion alone; `'clear'` means remove it.
   */
  champion: ChampionCell;
  /** Likewise for regional champions. A list is the complete set for the group. */
  regionalChampions: RegionalCell;
}

export interface GroupCsvResult {
  rows: GroupCsvRow[];
  errors: CsvIssue[];
  warnings: CsvIssue[];
  layout: GroupCsvLayout;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseGroupCsv(text: string): GroupCsvResult {
  const grid = parseCsv(text);
  const layout = detectGroupLayout(grid);

  const rows: GroupCsvRow[] = [];
  const errors: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];

  /** pathKey -> first row that claimed it, for duplicate detection. */
  const seenByPath = new Map<string, GroupCsvRow>();
  /** Group id -> first row that carried it. */
  const seenById = new Map<string, GroupCsvRow>();

  for (let r = layout.hasHeader ? 1 : 0; r < grid.length; r++) {
    const cells = grid[r] as string[];
    const line = r + 1;

    if (isBlankRow(cells)) continue;

    const id = readId(cells, layout, line);
    if (!id.ok) {
      errors.push({ line, message: id.error });
      continue;
    }

    const parsed =
      layout.style === 'columns'
        ? readColumns(cells, layout, line, warnings)
        : readPath(cells, layout, line);
    if (!parsed.ok) {
      errors.push({ line, message: parsed.error });
      continue;
    }

    const champions = readChampions(cells, layout, line);
    if (!champions.ok) {
      errors.push({ line, message: champions.error });
      continue;
    }

    const row: GroupCsvRow = {
      line,
      segments: parsed.value,
      display: displayPath(parsed.value),
      uniqueId: id.value,
      champion: champions.value.champion,
      regionalChampions: champions.value.regional,
    };

    if (row.uniqueId !== null) {
      const priorById = seenById.get(row.uniqueId);
      if (priorById) {
        errors.push({
          line,
          message:
            `Row ${line} and row ${priorById.line} both carry group id ${row.uniqueId}. ` +
            `A group can only appear once. Delete one of the rows.`,
        });
        continue;
      }
      seenById.set(row.uniqueId, row);
    }

    const key = pathKey(row.segments);
    const prior = seenByPath.get(key);
    if (prior) {
      if (prior.uniqueId !== null && row.uniqueId !== null) {
        // Two genuinely different groups that share a name and a parent. Both are real,
        // so neither row is wrong — but the path no longer identifies either of them,
        // which anything nested below them will run into.
        warnings.push({
          line,
          message:
            `Row ${line} and row ${prior.line} are two different groups that share the ` +
            `path "${row.display}". Both are kept, but nothing can be nested under ` +
            `either by name. Delete the row for the one you are not working on.`,
        });
        rows.push(row);
        continue;
      }
      if (prior.display === row.display) {
        warnings.push({
          line,
          message: `Row ${line} repeats "${row.display}" from row ${prior.line}. Ignoring the duplicate.`,
        });
      } else {
        // Same group, two spellings. We cannot know which name they want created.
        errors.push({
          line,
          message:
            `Row ${line} "${row.display}" and row ${prior.line} "${prior.display}" ` +
            `refer to the same group but are spelled differently. ` +
            `Make them identical and re-upload.`,
        });
      }
      continue;
    }

    seenByPath.set(key, row);
    rows.push(row);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'The file contains no group paths.' });
  }

  return { rows, errors, warnings, layout };
}

function readId(
  cells: readonly string[],
  layout: GroupCsvLayout,
  line: number,
): Parsed<string | null> {
  if (layout.idColumn === null) return { ok: true, value: null };

  const raw = (cells[layout.idColumn] ?? '').trim();
  // Blank is the normal case for a row someone added by hand: create it by name.
  if (raw === '') return { ok: true, value: null };

  const id = parseGroupId(raw);
  if (id === null) {
    return {
      ok: false,
      error:
        `Row ${line}: "${raw}" is not a group id. Copy the value from the ` +
        `Group Unique Id column of a downloaded structure file, or clear the cell ` +
        `to create a new group.`,
    };
  }
  return { ok: true, value: id };
}

/**
 * Read the two champion cells.
 *
 * Errors here stop the row rather than being downgraded to warnings: a champion cell
 * that cannot be read is one where somebody meant to grant access to a named person,
 * and the alternative to reporting it is quietly not granting it.
 */
function readChampions(
  cells: readonly string[],
  layout: GroupCsvLayout,
  line: number,
): Parsed<{ champion: ChampionCell; regional: RegionalCell }> {
  let champion: ChampionCell = null;
  let regional: RegionalCell = null;

  if (layout.championColumn !== null) {
    const parsed = parseChampionCell(cells[layout.championColumn] ?? '');
    if (!parsed.ok) return { ok: false, error: `Row ${line}: ${parsed.error}` };
    champion = parsed.value;
  }

  if (layout.regionalChampionColumn !== null) {
    const parsed = parseRegionalCell(cells[layout.regionalChampionColumn] ?? '');
    if (!parsed.ok) return { ok: false, error: `Row ${line}: ${parsed.error}` };
    regional = parsed.value;
  }

  return { ok: true, value: { champion, regional } };
}

/** One column per level: the whole path is spelled out across the row. */
function readColumns(
  cells: readonly string[],
  layout: GroupCsvLayout,
  line: number,
  warnings: CsvIssue[],
): Parsed<string[]> {
  const named = new Set([layout.idColumn, layout.championColumn, layout.regionalChampionColumn]);
  const extra = cells.filter(
    (cell, i) => cell.trim() !== '' && !named.has(i) && !layout.nameColumns.includes(i),
  );
  if (extra.length > 0) {
    // Silently ignoring these would drop the deepest levels of the path.
    return {
      ok: false,
      error:
        `Row ${line} has more columns filled in than the header row has. ` +
        `Add a "Level ${layout.nameColumns.length + 1}" header, or move the extra ` +
        `values into the existing columns.`,
    };
  }

  const raw = layout.nameColumns.map((i) => cells[i] ?? '');
  // Excel pads short rows out to the width of the sheet; trailing blanks mean the path
  // simply stops here.
  while (raw.length > 0 && (raw[raw.length - 1] as string).trim() === '') raw.pop();

  if (raw.length === 0) return { ok: false, error: `Row ${line}: the group path is empty.` };

  const segments: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const segment = createName(raw[i] as string);
    if (segment === '') {
      // A gap means either a typo or the outline style, where only the deepest cell is
      // filled and the parents are implied by the row above. That style silently
      // reparents everything below it when a row is deleted, so we do not accept it.
      return {
        ok: false,
        error:
          `Row ${line} has an empty level ${i + 1} but a name in level ${raw.length}. ` +
          `Write the full path on every row. Repeat the parent names rather than ` +
          `leaving them blank.`,
      };
    }
    segments.push(segment);
  }

  if (segments.some((s) => s.includes(PATH_SEPARATOR))) {
    // Almost always a file half-converted from the single-column format. Not fatal —
    // "|" is a legal character in a group name once columns carry the nesting — but it
    // is worth saying out loud before a group called "Finance | Procure to Pay" appears.
    warnings.push({
      line,
      message:
        `Row ${line} has "${PATH_SEPARATOR}" inside a level name. This file uses one ` +
        `column per level, so it will be part of the name rather than a level break.`,
    });
  }

  return { ok: true, value: segments };
}

/** One column holding the whole path, levels separated by "|". */
function readPath(
  cells: readonly string[],
  layout: GroupCsvLayout,
  line: number,
): Parsed<string[]> {
  // Champion columns hold people, not levels. Counting them as path cells would read a
  // perfectly good one-level file as somebody typing commas where they meant pipes.
  const named = new Set([layout.idColumn, layout.championColumn, layout.regionalChampionColumn]);
  const pathCells = cells.filter((_, i) => !named.has(i));
  const populated = pathCells.filter((c) => c.trim() !== '');

  if (populated.length > 1) {
    // Near-certainly someone typed "Top,Secondary,Lower" expecting commas to nest.
    // Parsing only the first cell would silently drop their structure.
    return {
      ok: false,
      error:
        `Row ${line} has ${populated.length} columns. Group levels are separated ` +
        `by "${PATH_SEPARATOR}" within a single column, not by commas. ` +
        `Did you mean "${populated.map((c) => c.trim()).join(` ${PATH_SEPARATOR} `)}"? ` +
        `To use one column per level, put "Level 1", "Level 2", … in the header row.`,
    };
  }

  const parsed = parsePath(pathCells[0] ?? '');
  if (!parsed.ok) return { ok: false, error: `Row ${line}: ${parsed.error}` };
  return { ok: true, value: parsed.value };
}
