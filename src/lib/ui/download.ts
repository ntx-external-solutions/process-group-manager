/**
 * Handing a file to the operator.
 *
 * Generated entirely in the browser — nothing is uploaded to produce a download, which
 * is what keeps "no customer data at rest" true for the files this tool creates.
 */

/**
 * A BOM, so Excel opens the file as UTF-8.
 *
 * Without it Excel guesses the local codepage and mangles every non-ASCII group name,
 * which then round-trips back as a rename. `parseCsv` strips it on the way in.
 */
const BOM = '﻿';

export function downloadText(filename: string, text: string, mimeType: string): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();

  URL.revokeObjectURL(url);
}

export function downloadCsv(filename: string, text: string): void {
  downloadText(filename, BOM + text, 'text/csv;charset=utf-8');
}

/** `process-shortcuts-2026-08-10.csv` — dated, because operators keep several. */
export function datedFilename(stem: string): string {
  const now = new Date();
  const date = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  return `${stem}-${date}.csv`;
}
