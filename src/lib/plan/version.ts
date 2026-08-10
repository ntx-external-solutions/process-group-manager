/**
 * What a write does to a process's version number.
 *
 * A fact about the product, not about the UI — the preview shows it before a run and
 * the report records it after one, so it lives where both can reach it.
 */

import type { WritePath } from './shortcutPlan.ts';

/**
 * The version the process is expected to end on.
 *
 * From the observed lifecycle (DESIGN.md): an edit bumps the minor version, and
 * publishing bumps the major and resets the minor. Everywhere this is shown it is
 * labelled "expected" — it is derived from behaviour, not from a documented guarantee,
 * and the API does not tell us the resulting version on the way back.
 */
export function expectedVersion(version: string, writePath: WritePath): string | null {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);

  if (writePath.kind === 'save-only') return `${major}.${minor + 1}`;
  return `${major + 1}.0`;
}
