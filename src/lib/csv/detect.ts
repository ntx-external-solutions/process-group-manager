/**
 * Working out what kind of CSV someone just dropped in.
 *
 * Four different files circulate in this workflow and they all look alike at a
 * glance: the group-structure file, the shortcut file, Process Manager's own Process
 * List export, and the retired wide shortcut file. Uploading the wrong one is the most
 * likely mistake a non-technical operator will make, and every one of them parses far
 * enough to produce a confusing error rather than an obvious one.
 *
 * Detection is by header only, and deliberately conservative: it says "unknown" rather
 * than guessing, because a wrong guess routes the file into the wrong parser.
 */

import { isGroupHeaderRow } from './layout.ts';
import { parseCsv } from './parse.ts';

export type CsvKind =
  /** One row per (process, group) pair, addressed by id. The upload format. */
  | 'shortcut-file'
  /** The retired wide format, with `Shortcut N` columns of group paths. */
  | 'legacy-shortcut-file'
  /** Process Manager's Process List report — one row per *placement*. A seed only. */
  | 'process-list'
  /** One full group path per row. */
  | 'group-file'
  | 'unknown';

const LEGACY_SHORTCUT_HEADER = /^shortcut\s*\d+$/i;

const PROCESS_ID_NAMES = ['process id', 'process unique id'];
const GROUP_ID_NAMES = [
  'group id',
  'group unique id',
  'shortcut group id',
  'shortcut group unique id',
];

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
  const hasAny = (candidates: readonly string[]): boolean => candidates.some(has);

  // Checked first, and before the Process List case: the export carries a
  // "Process Unique Id" too, and a file someone has added Group Unique Id rows to is
  // an upload rather than something to convert again.
  if (hasAny(PROCESS_ID_NAMES) && hasAny(GROUP_ID_NAMES)) {
    return { kind: 'shortcut-file', reason: 'One row per shortcut, addressed by id.' };
  }

  // Named rather than refused. This format was shipped, so files built to it are out
  // there, and "your columns do not match anything" would be a poor answer to one.
  if (header.some((h) => LEGACY_SHORTCUT_HEADER.test(h.trim()))) {
    return {
      kind: 'legacy-shortcut-file',
      reason: 'It names shortcut groups by path, in Shortcut 1, Shortcut 2… columns.',
    };
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
