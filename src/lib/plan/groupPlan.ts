/**
 * Group-structure planner. Creates, renames, and moves — never deletes.
 *
 * Pure function of (tree, parsed CSV rows) -> plan. No network, no writes — which is
 * what lets the preview the operator approves be the exact object the executor runs.
 *
 * A row's `Group Unique Id` is what makes rename and move expressible at all. Without
 * one, a path is the group's identity and the only question is whether it exists. With
 * one, the id says *which* group and the path columns say where it should end up and
 * what it should be called — so the same row can express "this group belongs somewhere
 * else now" instead of "make a second group over there".
 *
 * Nothing is inferred from a row's absence. A group missing from the file is untouched,
 * never deleted — see PLAN.md §4.2.
 */

import { displayPath, matchKey, pathKey } from '../csv/path.ts';
import type { GroupCsvRow } from '../csv/groups.ts';
import { GROUP_ID_HEADER } from '../csv/layout.ts';
import {
  isAncestorOf,
  pathOf,
  type GroupNode,
  type GroupTree,
  type PathAnchors,
  type Resolution,
  resolvePath,
} from './tree.ts';

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

export interface RenameAction {
  uniqueId: string;
  /** Where the group is now, for the operator to recognise it by. */
  fromDisplay: string;
  from: string;
  to: string;
  line: number;
}

export interface MoveAction {
  uniqueId: string;
  /** The group's own name, unchanged by the move. */
  name: string;
  /** Where it sits now. */
  fromDisplay: string;
  fromParentUniqueId: string | null;
  /** Where the file puts it. */
  toPath: string[];
  toDisplay: string;
  toParent: CreateParent;
  line: number;
}

export interface GroupPlan {
  creates: CreateAction[];
  renames: RenameAction[];
  moves: MoveAction[];
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

  const { anchors, blocked: idIssues, leafById } = anchorById(tree, rows);
  blocked.push(...idIssues);

  for (const row of rows) {
    const known = leafById.get(row.line);

    // The id pass already reported why this row cannot be used. Walking it by name as
    // well would report the same problem twice, or — worse — create something for a
    // row whose id we could not honour.
    if (known === null) continue;

    if (known) {
      const current = pathOf(tree, known);
      if (current !== null && pathKey(current) === pathKey(row.segments)) {
        // Already exactly where the file puts it, so every ancestor exists by
        // definition and there is nothing to walk. Walking anyway would re-derive them
        // by name and block the row whenever one of them shares a name with a sibling —
        // which would make re-uploading an untouched export report errors.
        const key = pathKey(row.segments);
        existing.push({
          path: row.segments,
          display: row.display,
          uniqueId: known.uniqueId,
          line: row.line,
        });
        if (!resolved.has(key)) resolved.set(key, known.uniqueId);
        continue;
      }
    }

    // Walk ancestors first so a create action's parent always precedes it.
    for (let depth = 1; depth <= row.segments.length; depth++) {
      const segments = row.segments.slice(0, depth);
      const key = pathKey(segments);

      // The row's own id already settled what this path means — including the case
      // where two groups answer to it, which name matching cannot get past. Rows the
      // id pass rejected were skipped above, so anything still here resolved.
      const byId = depth === row.segments.length ? leafById.get(row.line) : undefined;
      if (byId) {
        // One entry per row rather than per path: where two rows name two different
        // groups with the same path, the plan should show both ids, not just the first.
        existing.push({
          path: segments,
          display: displayPath(segments),
          uniqueId: byId.uniqueId,
          line: row.line,
        });
        if (!resolved.has(key)) resolved.set(key, byId.uniqueId);
        break;
      }

      if (planned.has(key) || resolved.has(key)) continue;

      const res = resolvePath(tree, segments, anchors);

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
        // Fixable from the spreadsheet now, rather than only by renaming groups in
        // Process Manager: put the id of the one they mean on that group's own row.
        blocked.push({
          line: row.line,
          display: displayPath(segments),
          message:
            `"${displayPath(segments)}" matches ${res.candidates.length} existing groups. ` +
            `Add a "${GROUP_ID_HEADER}" column and put the id of the one you mean on ` +
            `its row: ${res.candidates.map((c) => `${c.uniqueId} ("${c.title}")`).join(', ')}.`,
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

  const { renames, moves } = planRestructure(tree, rows, leafById, anchors, {
    planned,
    blocked,
  });

  return { status: 'ok', plan: { creates, renames, moves, existing, blocked } };
}

interface RestructureContext {
  planned: ReadonlyMap<string, number>;
  /** Appended to in place — a refused rename or move belongs with every other refusal. */
  blocked: PlanIssue[];
}

/**
 * Work out which id-bearing rows describe a group that has to be renamed or moved.
 *
 * Runs after the create pass, because a row may well be moving a group underneath a
 * parent this same run is about to create — the destination is a plan sequence, not a
 * uniqueId, until the executor gets there.
 */
function planRestructure(
  tree: GroupTree,
  rows: readonly GroupCsvRow[],
  leafById: ReadonlyMap<number, GroupNode | null>,
  anchors: PathAnchors,
  ctx: RestructureContext,
): { renames: RenameAction[]; moves: MoveAction[] } {
  const renames: RenameAction[] = [];
  const candidates: MoveAction[] = [];

  // Rows the create pass already refused. Renaming one in place while its move is
  // blocked would apply half of what the row asks for, and reporting the same
  // ambiguity twice is just noise.
  const alreadyBlocked = new Set(ctx.blocked.map((issue) => issue.line));

  for (const row of rows) {
    if (alreadyBlocked.has(row.line)) continue;

    const node = leafById.get(row.line);
    if (!node) continue;

    const here = pathOf(tree, node);

    // Already exactly where the file puts it, under the name the file gives it. Any
    // further comparison would be against a *re-derived* location, and re-deriving a
    // path that two groups answer to picks one of them arbitrarily — which is how an
    // untouched export ends up proposing to move a group next door to itself.
    if (here !== null && pathKey(here) === pathKey(row.segments)) continue;

    const fromDisplay = here === null ? node.title : displayPath(here);
    const wantedName = row.segments[row.segments.length - 1] as string;

    // Names are compared the way paths are matched, so re-uploading a file whose case
    // or inner spacing drifted does not churn every group through a rename.
    if (matchKey(node.title) !== matchKey(wantedName)) {
      renames.push({
        uniqueId: node.uniqueId,
        fromDisplay,
        from: node.title,
        to: wantedName,
        line: row.line,
      });
    }

    const resolvedDestination = destinationOf(tree, row, anchors, ctx);
    if (resolvedDestination.kind === 'unresolved') {
      // The desired parent was neither found nor planned, which only happens when an
      // ancestor was already blocked and reported.
      continue;
    }
    if (resolvedDestination.kind === 'ambiguous') {
      ctx.blocked.push({
        line: row.line,
        display: row.display,
        message:
          `"${resolvedDestination.display}" matches ${resolvedDestination.candidates.length} ` +
          `existing groups, so there is no telling which one "${node.title}" should move ` +
          `into. Put the id of the one you mean on its own row and delete the row for ` +
          `the other: ` +
          `${resolvedDestination.candidates.map((c) => `${c.uniqueId} ("${c.title}")`).join(', ')}.`,
      });
      continue;
    }
    const destination = resolvedDestination.parent;

    const wantedParentId =
      destination.kind === 'root'
        ? null
        : destination.kind === 'existing'
          ? destination.uniqueId
          : // A parent this run is creating cannot be where the group already is.
            undefined;

    if (wantedParentId !== undefined && wantedParentId === node.parentUniqueId) continue;

    if (destination.kind === 'existing') {
      const target = tree.byUniqueId.get(destination.uniqueId);
      if (target?.isDocumentGroup) {
        ctx.blocked.push({
          line: row.line,
          display: row.display,
          message:
            `"${target.title}" is a document-only group and cannot contain process ` +
            `groups, so "${node.title}" cannot be moved into it.`,
        });
        continue;
      }
      if (target && isAncestorOf(tree, node, target)) {
        // Reparenting a group under its own descendant detaches that whole subtree from
        // the tree — it becomes a ring with no route back to a root.
        ctx.blocked.push({
          line: row.line,
          display: row.display,
          message:
            `"${node.title}" cannot be moved inside "${target.title}", which is one of ` +
            `its own subgroups. Move "${target.title}" out first.`,
        });
        continue;
      }
    }

    candidates.push({
      uniqueId: node.uniqueId,
      name: node.title,
      fromDisplay,
      fromParentUniqueId: node.parentUniqueId,
      toPath: row.segments,
      toDisplay: row.display,
      toParent: destination,
      line: row.line,
    });
  }

  return { renames, moves: withoutCycles(candidates, ctx.blocked) };
}

type Destination =
  | { kind: 'parent'; parent: CreateParent }
  /** Two or more groups answer to the destination path. We refuse to pick one. */
  | { kind: 'ambiguous'; display: string; candidates: GroupNode[] }
  | { kind: 'unresolved' };

/**
 * Where the file wants this row's group to hang from.
 *
 * Resolved against the tree rather than against the create pass's `resolved` map: that
 * map holds one uniqueId per path, so for a path two groups share it holds whichever
 * was seen first. Good enough to attach a *new* group to; not good enough to decide
 * where an existing one, with its processes and permissions, gets moved.
 */
function destinationOf(
  tree: GroupTree,
  row: GroupCsvRow,
  anchors: PathAnchors,
  ctx: RestructureContext,
): Destination {
  const parentSegments = row.segments.slice(0, -1);
  if (parentSegments.length === 0) return { kind: 'parent', parent: { kind: 'root' } };

  const display = displayPath(parentSegments);
  const seq = ctx.planned.get(pathKey(parentSegments));
  if (seq !== undefined) {
    return { kind: 'parent', parent: { kind: 'planned', seq, display } };
  }

  const res = resolvePath(tree, parentSegments, anchors);
  if (res.kind === 'ambiguous') {
    return { kind: 'ambiguous', display, candidates: res.candidates };
  }
  if (res.kind === 'found') {
    return { kind: 'parent', parent: { kind: 'existing', uniqueId: res.node.uniqueId, display } };
  }
  return { kind: 'unresolved' };
}

/**
 * Drop moves that would only form a cycle in combination.
 *
 * Each move is legal against the tree as it stands — `A` under `B` and `B` under `A` both
 * pass on their own — so the check has to be run against the structure the plan would
 * produce, not the one it started from.
 */
function withoutCycles(candidates: readonly MoveAction[], blocked: PlanIssue[]): MoveAction[] {
  const destinationOfId = new Map<string, string | null>();
  for (const move of candidates) {
    // A destination this run is creating is a fresh leaf, so it can never close a ring.
    destinationOfId.set(
      move.uniqueId,
      move.toParent.kind === 'existing' ? move.toParent.uniqueId : null,
    );
  }

  const out: MoveAction[] = [];
  for (const move of candidates) {
    let cursor = move.toParent.kind === 'existing' ? move.toParent.uniqueId : null;
    let cyclic = false;

    for (let hops = 0; cursor !== null && hops <= candidates.length + 1; hops++) {
      if (cursor === move.uniqueId) {
        cyclic = true;
        break;
      }
      // Only groups this plan is moving can have a parent other than their current one;
      // anything else terminates the walk.
      if (!destinationOfId.has(cursor)) break;
      cursor = destinationOfId.get(cursor) ?? null;
    }

    if (cyclic) {
      blocked.push({
        line: move.line,
        display: move.toDisplay,
        message:
          `Moving "${move.name}" to "${move.toDisplay}" would put it inside a group that ` +
          `this same file moves inside it. Apply one of the two moves first.`,
      });
      continue;
    }

    out.push(move);
  }

  return out;
}

interface IdPass {
  /** Paths pinned to a specific group, for the name walk to reuse. */
  anchors: Map<string, GroupNode>;
  blocked: PlanIssue[];
  /** Row line -> the group its id resolved to, or null when the id could not be used. */
  leafById: Map<number, GroupNode | null>;
}

/**
 * Resolve every row that carries a Group Unique Id, before anything is matched by name.
 *
 * Lookup is by id straight out of the tree index, *not* by walking the row's path. That
 * is the whole point: the path columns describe where the group should end up, so a row
 * asking for a move names a path the group is not at yet. Walking it would report the
 * group as missing and create a second one.
 *
 * It also makes a tenant with repeated group names workable. Two siblings called
 * "Finance" defeat name matching entirely; an id picks one of them, and once a path is
 * pinned, rows nested below it walk by name as usual.
 *
 * Requires a fully-loaded tree — see buildGroupPlan, which arranges that whenever any
 * row carries an id.
 */
function anchorById(tree: GroupTree, rows: readonly GroupCsvRow[]): IdPass {
  const anchors = new Map<string, GroupNode>();
  const blocked: PlanIssue[] = [];
  const leafById = new Map<number, GroupNode | null>();

  // Paths that more than one id lays claim to. Both groups are real, so neither row is
  // wrong — but the path no longer picks one out, so neither may anchor it.
  const idsByPath = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.uniqueId === null) continue;
    const key = pathKey(row.segments);
    let ids = idsByPath.get(key);
    if (!ids) {
      ids = new Set();
      idsByPath.set(key, ids);
    }
    ids.add(row.uniqueId);
  }

  // Shallowest first, so a parent is pinned before the rows nested under it are read.
  // File order would usually do, but only because exports happen to be in tree order.
  const idRows = rows
    .filter((row) => row.uniqueId !== null)
    .sort((a, b) => a.segments.length - b.segments.length);

  for (const row of idRows) {
    const id = row.uniqueId as string;
    const rowKey = pathKey(row.segments);
    const node = tree.byUniqueId.get(id);

    if (!node) {
      leafById.set(row.line, null);
      blocked.push({
        line: row.line,
        display: row.display,
        message:
          `No group with id ${id} exists in this tenant. It may have been deleted since ` +
          `you downloaded the file. Download the current structure again, or clear the ` +
          `id to create a new group at "${row.display}".`,
      });
      continue;
    }

    if (node.isDocumentGroup) {
      leafById.set(row.line, null);
      blocked.push({
        line: row.line,
        display: row.display,
        message:
          `"${node.title}" is a document-only group. This tool does not manage those. ` +
          `Remove the row, or convert it in Process Manager.`,
      });
      continue;
    }

    leafById.set(row.line, node);
    if ((idsByPath.get(rowKey)?.size ?? 0) === 1) anchors.set(rowKey, node);
  }

  return { anchors, blocked, leafById };
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
  return plan.creates.length === 0 && plan.renames.length === 0 && plan.moves.length === 0;
}

/** Total writes the plan implies, for the progress bar and the "are you sure" copy. */
export function groupActionCount(plan: GroupPlan): number {
  return plan.creates.length + plan.renames.length + plan.moves.length;
}
