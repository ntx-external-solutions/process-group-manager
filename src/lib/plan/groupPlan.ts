/**
 * Group-structure planner. Create-only: never moves, renames, or deletes.
 *
 * Pure function of (tree, parsed CSV rows) -> plan. No network, no writes — which is
 * what lets the preview the operator approves be the exact object the executor runs.
 */

import { displayPath, pathKey } from '../csv/path.ts';
import type { GroupCsvRow } from '../csv/groups.ts';
import { type GroupTree, resolvePath } from './tree.ts';

/** Where a group being created will be attached. */
export type CreateParent =
  | { kind: 'root' }
  | { kind: 'existing'; uniqueId: string; display: string }
  /** The group created by an earlier step in this same plan. */
  | { kind: 'planned'; seq: number; display: string };

export interface CreateAction {
  /** Execution order. Parents always precede their children. */
  seq: number;
  path: string[];
  display: string;
  /** Name to send to RenameGroup — the CSV spelling, outer-trimmed. */
  name: string;
  parent: CreateParent;
  /** CSV line that first required this group. */
  line: number;
}

export interface ExistingGroup {
  path: string[];
  display: string;
  uniqueId: string;
  line: number;
}

export interface PlanIssue {
  line: number;
  display: string;
  message: string;
}

export interface GroupPlan {
  creates: CreateAction[];
  existing: ExistingGroup[];
  blocked: PlanIssue[];
}

export type PlanOutcome =
  /** Resolution needs more of the tree. Load these, then call again. */
  | { status: 'needs-load'; uniqueIds: string[] }
  | { status: 'ok'; plan: GroupPlan };

/**
 * Plan the group structure.
 *
 * Because the tree loads lazily, this may report that it needs more data. Callers
 * loop: plan -> load -> plan, which converges within the depth of the deepest path.
 */
export function planGroups(tree: GroupTree, rows: readonly GroupCsvRow[]): PlanOutcome {
  const creates: CreateAction[] = [];
  const existing: ExistingGroup[] = [];
  const blocked: PlanIssue[] = [];
  const needsLoad = new Set<string>();

  /** pathKey -> plan seq, for groups this run will create. */
  const planned = new Map<string, number>();
  /** pathKey -> uniqueId, for groups confirmed to already exist. */
  const resolved = new Map<string, string>();

  for (const row of rows) {
    // Walk ancestors first so a create action's parent always precedes it.
    for (let depth = 1; depth <= row.segments.length; depth++) {
      const segments = row.segments.slice(0, depth);
      const key = pathKey(segments);

      if (planned.has(key) || resolved.has(key)) continue;

      const res = resolvePath(tree, segments);

      if (res.kind === 'found') {
        resolved.set(key, res.node.uniqueId);
        existing.push({
          path: segments,
          display: displayPath(segments),
          uniqueId: res.node.uniqueId,
          line: row.line,
        });
        continue;
      }

      if (res.kind === 'unloaded') {
        if (res.parent) needsLoad.add(res.parent.uniqueId);
        // Stop descending this row; we cannot know what lies below yet.
        break;
      }

      if (res.kind === 'ambiguous') {
        blocked.push({
          line: row.line,
          display: displayPath(segments),
          message:
            `"${displayPath(segments)}" matches ${res.candidates.length} existing groups ` +
            `(${res.candidates.map((c) => `"${c.title}"`).join(', ')}). ` +
            `Rename them in Process Manager so they differ, then re-upload.`,
        });
        break;
      }

      if (res.kind === 'documentGroup') {
        blocked.push({
          line: row.line,
          display: displayPath(segments),
          message:
            `"${res.node.title}" is a document-only group and cannot contain ` +
            `process groups. Remove it from the path or convert it in Process Manager.`,
        });
        break;
      }

      // res.kind === 'missing' — plan a create.
      const parent = parentRef(segments, planned, resolved);
      if (parent === null) {
        // Parent was neither found nor planned. Only reachable if an ancestor was
        // blocked above, in which case that error is already reported.
        break;
      }

      const seq = creates.length;
      creates.push({
        seq,
        path: segments,
        display: displayPath(segments),
        name: segments[segments.length - 1] as string,
        parent,
        line: row.line,
      });
      planned.set(key, seq);
    }
  }

  if (needsLoad.size > 0) {
    return { status: 'needs-load', uniqueIds: [...needsLoad] };
  }

  return { status: 'ok', plan: { creates, existing, blocked } };
}

/**
 * Resolve what a new group should hang from.
 *
 * Deliberately does *not* consult resolvePath's `parent`: that is the deepest
 * *existing* ancestor, which for "A|B|C" with only A present is A — two levels above
 * C. Because we walk depths in ascending order, the immediate parent has already been
 * recorded in `planned` or `resolved`, so we look it up by its own path key.
 */
function parentRef(
  segments: readonly string[],
  planned: ReadonlyMap<string, number>,
  resolved: ReadonlyMap<string, string>,
): CreateParent | null {
  if (segments.length === 1) return { kind: 'root' };

  const parentSegments = segments.slice(0, -1);
  const parentDisplay = displayPath(parentSegments);
  const parentKey = pathKey(parentSegments);

  const seq = planned.get(parentKey);
  if (seq !== undefined) {
    return { kind: 'planned', seq, display: parentDisplay };
  }

  const uniqueId = resolved.get(parentKey);
  if (uniqueId !== undefined) {
    return { kind: 'existing', uniqueId, display: parentDisplay };
  }

  return null;
}

/** True when the plan would change nothing — a re-run of an already-applied file. */
export function isNoOp(plan: GroupPlan): boolean {
  return plan.creates.length === 0;
}
