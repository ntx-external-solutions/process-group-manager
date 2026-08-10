/**
 * Group-structure CSV: one full group path per row.
 *
 * Every message here is read by someone who is not a developer, so errors name the
 * row number and say what to do, not what went wrong internally.
 */

import { isBlankRow, parseCsv } from './parse.ts';
import { displayPath, parsePath, pathKey, PATH_SEPARATOR } from './path.ts';

export interface CsvIssue {
  /** 1-based line number as the operator sees it in Excel. */
  line: number;
  message: string;
}

export interface GroupCsvRow {
  line: number;
  segments: string[];
  display: string;
}

export interface GroupCsvResult {
  rows: GroupCsvRow[];
  errors: CsvIssue[];
  warnings: CsvIssue[];
}

const HEADER_PATTERN = /^group\s*path$/i;

export function parseGroupCsv(text: string): GroupCsvResult {
  const grid = parseCsv(text);
  const rows: GroupCsvRow[] = [];
  const errors: CsvIssue[] = [];
  const warnings: CsvIssue[] = [];

  /** pathKey -> first row that claimed it, for duplicate detection. */
  const seen = new Map<string, GroupCsvRow>();

  let startIndex = 0;
  const firstCell = grid[0]?.[0]?.trim() ?? '';
  if (HEADER_PATTERN.test(firstCell)) startIndex = 1;

  for (let r = startIndex; r < grid.length; r++) {
    const cells = grid[r] as string[];
    const line = r + 1;

    if (isBlankRow(cells)) continue;

    const populated = cells.filter((c) => c.trim() !== '');
    if (populated.length > 1) {
      // Near-certainly someone typed "Top,Secondary,Lower" expecting commas to nest.
      // Parsing only the first cell would silently drop their structure.
      errors.push({
        line,
        message:
          `Row ${line} has ${populated.length} columns. Group levels are separated ` +
          `by "${PATH_SEPARATOR}" within a single column, not by commas. ` +
          `Did you mean "${populated.map((c) => c.trim()).join(` ${PATH_SEPARATOR} `)}"?`,
      });
      continue;
    }

    const parsed = parsePath(cells[0] ?? '');
    if (!parsed.ok) {
      errors.push({ line, message: `Row ${line}: ${parsed.error}` });
      continue;
    }

    const row: GroupCsvRow = {
      line,
      segments: parsed.value,
      display: displayPath(parsed.value),
    };

    const key = pathKey(row.segments);
    const prior = seen.get(key);
    if (prior) {
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

    seen.set(key, row);
    rows.push(row);
  }

  if (rows.length === 0 && errors.length === 0) {
    errors.push({ line: 0, message: 'The file contains no group paths.' });
  }

  return { rows, errors, warnings };
}
