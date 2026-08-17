/**
 * A short-lived copy of the tenant's group tree.
 *
 * Reading the whole tree is one request per group — around 92 on the measured tenant,
 * unbounded on a larger one — and the plan screen reads it up to three times in a row:
 * download the hierarchy, upload a shortcuts file, upload a corrected one. This holds
 * the result for a few minutes so those are one read rather than three.
 *
 * What it deliberately does **not** do is hold the tree for the length of a session. The
 * tree is not display data: it is the baseline every plan is diffed against, and a group
 * somebody else created is invisible to a stale copy — which produces a duplicate rather
 * than an error, because the executor has no existence check of its own. Three rules keep
 * that from happening:
 *
 *  1. it expires, and the age is shown on screen next to a Refresh control;
 *  2. `invalidate()` is called after anything is written, so the run's own effects can
 *     never be missing from the next plan;
 *  3. planning from a cached tree does not authorise writing from one — the branches a
 *     plan touches are re-read immediately before Apply (see plan/revalidate.ts).
 *
 * The cached tree is handed out by reference and treated as read-only. Nothing outside
 * the loader may call addLevel on it.
 */

import { loadWholeTree, type PlanGateway, type Progress } from '../plan/orchestrate.ts';
import type { GroupTree } from '../plan/tree.ts';

/** How long a read stays usable. Long enough to chain two actions, short enough to notice. */
export const TREE_TTL_MS = 5 * 60 * 1000;

interface Entry {
  tenant: string;
  tree: GroupTree;
  loadedAt: number;
}

let entry: Entry | null = null;

/** When the held tree was read, or null when there is none. Drives the on-screen age. */
export function cachedTreeAt(tenant: string, now: number = Date.now()): number | null {
  if (!entry || entry.tenant !== tenant) return null;
  if (now - entry.loadedAt >= TREE_TTL_MS) return null;
  return entry.loadedAt;
}

/**
 * Forget the held tree.
 *
 * Called after every run, and whenever the operator asks for a refresh. Cheap to call
 * needlessly, and the failure mode of *not* calling it is a duplicated group.
 */
export function invalidateTree(): void {
  entry = null;
}

export interface WholeTreeOptions {
  onProgress?: Progress | undefined;
  /** Skip the cache and read the tenant again. */
  force?: boolean | undefined;
  now?: number | undefined;
}

/**
 * The whole tree, from the cache when it is fresh and from Process Manager otherwise.
 *
 * Keyed by tenant so a sign-out and sign-in to somewhere else cannot be served one
 * tenant's structure under another's name.
 */
export async function wholeTree(
  gateway: PlanGateway,
  tenant: string,
  options: WholeTreeOptions = {},
): Promise<GroupTree> {
  const now = options.now ?? Date.now();

  if (!options.force && entry && entry.tenant === tenant && now - entry.loadedAt < TREE_TTL_MS) {
    return entry.tree;
  }

  const tree = await loadWholeTree(gateway, {
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });
  entry = { tenant, tree, loadedAt: options.now ?? Date.now() };
  return tree;
}

/** "2 minutes ago", for the line above the Refresh button. */
export function describeAge(loadedAt: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - loadedAt) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  return minutes <= 1 ? 'a minute ago' : `${minutes} minutes ago`;
}
