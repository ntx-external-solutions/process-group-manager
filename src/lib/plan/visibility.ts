/**
 * Who can see a group before and after it moves.
 *
 * Permissions in Process Manager are inherited down the tree, so reparenting a group
 * changes the audience for everything inside it — including processes nobody thought
 * they were touching. That is DESIGN.md R5, and it is the one consequence of a move
 * that is genuinely invisible in a structure diagram: the tree looks tidier and the
 * readership silently changed.
 *
 * The product answers this question itself. `GetTotalSpecifiedGroupRoleAndUserViewers`
 * is what the Process Manager UI calls immediately after every move, so these are its
 * numbers rather than ours — one batch call for the whole plan, not one per group.
 *
 * Deliberately advisory. A viewer count that cannot be read must never stop a plan the
 * operator has approved: it is context for a decision, not a gate on one.
 */

import type { GroupViewerCount } from '../pm/groups.ts';
import type { GroupPlan, MoveAction } from './groupPlan.ts';
import type { GroupTree } from './tree.ts';

export interface ViewerCount {
  users: number;
  roles: number;
}

export interface MoveVisibility {
  uniqueId: string;
  name: string;
  fromDisplay: string;
  toDisplay: string;
  /** Audience of the group as it sits today. */
  before: ViewerCount | null;
  /**
   * Audience of the destination. Null when it cannot be known — most often because the
   * destination is a group this same run has yet to create.
   */
  after: ViewerCount | null;
  /** True when the destination does not exist yet, so there is nothing to compare to. */
  intoNewParent: boolean;
}

export interface VisibilityReport {
  moves: MoveVisibility[];
  /** Set when the counts could not be read at all. The plan is unaffected. */
  unavailable: string | null;
}

/** Numeric group ids the report needs. The endpoint takes those, not UUIDs. */
export function viewerLookupIds(tree: GroupTree, plan: GroupPlan): number[] {
  const ids = new Set<number>();

  for (const move of plan.moves) {
    const source = tree.byUniqueId.get(move.uniqueId);
    if (source) ids.add(source.id);
    if (move.toParent.kind === 'existing') {
      const destination = tree.byUniqueId.get(move.toParent.uniqueId);
      if (destination) ids.add(destination.id);
    }
  }

  return [...ids];
}

/**
 * Pair each move with the audience at both ends.
 *
 * A group created by this same run has no audience yet — it inherits one the moment it
 * exists — so those are reported as unknown rather than as zero, which would read as
 * "nobody will see this" when the truth is "we cannot say".
 */
export function describeVisibility(
  tree: GroupTree,
  plan: GroupPlan,
  counts: readonly GroupViewerCount[],
): MoveVisibility[] {
  const byGroupId = new Map(counts.map((c) => [c.groupId, c]));

  const lookup = (uniqueId: string | null): ViewerCount | null => {
    if (uniqueId === null) return null;
    const node = tree.byUniqueId.get(uniqueId);
    if (!node) return null;
    const found = byGroupId.get(node.id);
    return found ? { users: found.totalUsers, roles: found.totalRoles } : null;
  };

  return plan.moves.map((move: MoveAction) => ({
    uniqueId: move.uniqueId,
    name: move.name,
    fromDisplay: move.fromDisplay,
    toDisplay: move.toDisplay,
    before: lookup(move.uniqueId),
    after: move.toParent.kind === 'existing' ? lookup(move.toParent.uniqueId) : null,
    intoNewParent: move.toParent.kind === 'planned',
  }));
}

/**
 * Moves where the audience demonstrably changes.
 *
 * The ones worth reading. A move between two branches with the same readership is a
 * tidy-up; a move that drops a group from twelve viewers to one is a decision.
 */
export function audienceChanges(moves: readonly MoveVisibility[]): MoveVisibility[] {
  return moves.filter((m) => {
    if (m.before === null || m.after === null) return false;
    return m.before.users !== m.after.users || m.before.roles !== m.after.roles;
  });
}
