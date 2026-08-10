/**
 * Working out what kind of CSV someone just dropped in.
 *
 * Three different files circulate in this workflow and they all look alike at a
 * glance: the group-structure file, the shortcut file, and Process Manager's own
 * Process List export. Uploading the wrong one is the most likely mistake a
 * non-technical operator will make, and every one of them parses far enough to produce
 * a confusing error rather than an obvious one.
 *
 * Detection is by header only, and deliberately conservative: it says "unknown" rather
 * than guessing, because a wrong guess routes the file into the wrong parser.
 */

import { isGroupHeaderRow } from './layout.ts';
import { parseCsv } from './parse.ts';

export type CsvKind =
  /** One row per process, with `Shortcut N` columns. The upload format. */
  | 'shortcut-file'
  /** Process Manager's Process List report — one row per *placement*. A seed only. */
  | 'process-list'
  /** One full group path per row. */
  | 'group-file'
  | 'unknown';

const SHORTCUT_HEADER = /^shortcut\s*\d+$/i;

export interface Classification {
  kind: CsvKind;
  /** Plain-language reason, shown when the file does not suit the chosen task. */
  reason: string;
}

export function classifyCsv(text: string): Classification {
  const header = parseCsv(text)[0];
  if (!header) return { kind: 'unknown', reason: 'The file is empty.' };

  const names = header.map((h) => h.trim().toLowerCase());
  const has = (name: string): boolean => names.includes(name);

  // Checked first: a Process List export with Shortcut columns added is a valid
  // upload, and that is exactly what §4.5 tells operators to produce.
  if (header.some((h) => SHORTCUT_HEADER.test(h.trim()))) {
    return { kind: 'shortcut-file', reason: 'Has Shortcut columns.' };
  }

  if (has('process unique id') && has('group path') && has('short cut')) {
    return {
      kind: 'process-list',
      reason: "This is Process Manager's Process List export.",
    };
  }

  // A header made entirely of group-column names — "Group Unique Id", "Group Path",
  // "Level 1"… — is a group file however wide it is. Checked after the process-list
  // case above, which also has a "Group Path" column but brings process columns with it.
  if (isGroupHeaderRow(header)) {
    return { kind: 'group-file', reason: 'One group per row, levels across columns.' };
  }

  // With no recognisable header, a single column is the group file: it is the only
  // one-column file in this workflow, and a file of bare paths carries no header at all.
  if (names.length === 1) {
    return { kind: 'group-file', reason: 'One group path per row.' };
  }

  return {
    kind: 'unknown',
    reason: 'The columns do not match any file this tool understands.',
  };
}
