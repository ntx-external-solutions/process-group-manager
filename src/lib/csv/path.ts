/**
 * Group-path parsing and normalisation.
 *
 * Every comparison between a CSV path and a live Process Manager group goes through
 * here. The rules are documented in PLAN.md §4.1; the important one is the split
 * between matching and creation:
 *
 *   matchKey()   - aggressive: trim, collapse internal whitespace, lowercase.
 *                  Used only to decide "does this group already exist?"
 *   createName() - conservative: trim outer whitespace, nothing else.
 *                  Used only when we actually create a group.
 *
 * The tenant contains a real group named "Partner Facing " with a trailing space.
 * We have to match it without recreating it, and without silently renaming it —
 * which is exactly why these two functions are not the same function.
 */

export const PATH_SEPARATOR = '|';

/** How a path is rendered back to a human, in errors and reports. */
export const PATH_DISPLAY_JOINER = ' | ';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Collapse a group name to its matching key.
 *
 * Deliberately lossy. Two names that produce the same key are treated as the same
 * group, so this must never be used to create or rename anything.
 */
export function matchKey(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * The name we will actually send to Process Manager when creating a group.
 *
 * Outer whitespace goes (a leading/trailing space in a CSV cell is virtually always
 * an editing accident) but internal spacing and case are preserved exactly as typed.
 */
export function createName(name: string): string {
  return name.trim();
}

/** Join segments for display in errors, reports, and the UI. */
export function displayPath(segments: readonly string[]): string {
  return segments.join(PATH_DISPLAY_JOINER);
}

const GROUP_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Normalise a Group Unique Id cell, or null when it is not one.
 *
 * Deliberately strict. The alternative to rejecting a malformed id is treating it as
 * "no id given", which silently turns "this exact group" into "whatever is named that"
 * — the precise failure the column exists to prevent.
 */
export function parseGroupId(raw: string): string | null {
  const trimmed = raw.trim();
  // Process Manager writes them lowercase; GUIDs compare case-insensitively, so
  // normalise once here rather than at every comparison.
  return GROUP_ID_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * A stable key for a full path, used to index the existing-tree map.
 * Built from matchKey segments so lookups follow the matching rules above.
 */
export function pathKey(segments: readonly string[]): string {
  // NUL joiner, not a space: joining with a space would make ['A B','C'] and
  // ['A','B C'] collide into the same key. NUL cannot occur in a group name.
  return segments.map(matchKey).join('\u0000');
}

/**
 * Parse a raw CSV cell into path segments.
 *
 * Returns display-form segments (outer-trimmed, otherwise untouched). Callers derive
 * match keys via matchKey/pathKey as needed.
 */
export function parsePath(raw: string): Result<string[]> {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, error: 'Group path is empty.' };
  }

  const rawSegments = trimmed.split(PATH_SEPARATOR);
  const segments: string[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const segment = createName(rawSegments[i] ?? '');
    if (segment === '') {
      // Covers "A || B", a leading "| A", and a trailing "A |". All are almost
      // certainly typos, and none has an unambiguous intended meaning.
      return {
        ok: false,
        error:
          rawSegments.length === 1
            ? 'Group path is empty.'
            : `Group path has an empty level at position ${i + 1}: "${trimmed}". ` +
              `Check for a doubled or trailing "${PATH_SEPARATOR}".`,
      };
    }
    segments.push(segment);
  }

  return { ok: true, value: segments };
}

/**
 * Whether a live group name can ever be addressed by a CSV path.
 *
 * "|" is the path separator and we deliberately support no escape syntax, so a group
 * whose name contains one is unreachable. We surface those rather than silently
 * failing to match them later.
 */
export function isAddressableGroupName(name: string): boolean {
  return !name.includes(PATH_SEPARATOR);
}

/** All proper ancestors of a path, outermost first. `[A,B,C]` → `[[A],[A,B]]`. */
export function ancestorsOf(segments: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 1; i < segments.length; i++) {
    out.push(segments.slice(0, i));
  }
  return out;
}
