/**
 * Turning planners into a dry run.
 *
 * The planners are pure functions over an already-loaded tree. This module owns the
 * awkward part: the group tree only loads one level per call, so planning and loading
 * have to alternate until the plan stops asking for more.
 *
 * Everything here reads. Nothing in this file writes to Process Manager.
 */

import { displayPath } from '../csv/path.ts';
import type { GroupCsvRow } from '../csv/groups.ts';
import { isNoInstruction, type ShortcutCsvProcess } from '../csv/shortcuts.ts';
import type { GroupViewerCount } from '../pm/groups.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type { ChildTreeItemsResponse } from '../pm/types.ts';
import { describeVisibility, viewerLookupIds, type VisibilityReport } from './visibility.ts';
import { addLevel, allGroups, emptyTree, type GroupTree } from './tree.ts';
import { planGroups, type GroupPlan } from './groupPlan.ts';
import {
  planShortcuts,
  type ProcessResolution,
  type PublishedBehaviour,
  type ResolvedGroup,
  type ShortcutPlan,
  type ShortcutPlanDeps,
  type ShortcutPlanOptions,
} from './shortcutPlan.ts';

/** The reads this module needs. Implemented over the proxy in the browser. */
export interface PlanGateway {
  groupsTree(parentUniqueId: string | null): Promise<ChildTreeItemsResponse>;
  processSummary(processUniqueId: string): Promise<ProcessSummary>;
  /** Batch viewer counts, for the visibility impact of a move. */
  groupViewers(groupIds: number[]): Promise<GroupViewerCount[]>;
}

export interface Progress {
  (event: { phase: 'tree' | 'processes'; done: number; total: number | null }): void;
}

/**
 * Guard against a pathological loop. Each pass resolves at least one more level, so
 * the bound is really "deeper than any plausible group tree" rather than a real limit.
 */
const MAX_PASSES = 64;

export interface GroupPlanResult {
  plan: GroupPlan;
  tree: GroupTree;
}

/**
 * Read the audience at both ends of every planned move.
 *
 * Advisory throughout: a failure here reports itself and leaves the plan alone. Losing
 * the impact figures is worse than not having them, but not as bad as refusing to apply
 * a plan the operator has already reviewed.
 */
export async function describeMoveVisibility(
  gateway: PlanGateway,
  tree: GroupTree,
  plan: GroupPlan,
): Promise<VisibilityReport> {
  if (plan.moves.length === 0) return { moves: [], unavailable: null };

  const groupIds = viewerLookupIds(tree, plan);
  if (groupIds.length === 0) {
    return { moves: describeVisibility(tree, plan, []), unavailable: null };
  }

  try {
    const counts = await gateway.groupViewers(groupIds);
    return { moves: describeVisibility(tree, plan, counts), unavailable: null };
  } catch (error) {
    return {
      moves: describeVisibility(tree, plan, []),
      unavailable: error instanceof Error ? error.message : 'Could not read viewer counts.',
    };
  }
}

/** Just the top level — the starting point for any resolution. */
export async function loadRootTree(gateway: PlanGateway): Promise<GroupTree> {
  const tree = emptyTree();
  const root = await gateway.groupsTree(null);
  addLevel(tree, null, root.treeItems ?? []);
  return tree;
}

/**
 * Load the entire group tree, breadth-first.
 *
 * Only used to export the current structure, where there is no CSV to say which
 * branches matter. Everything else loads on demand, because this is one request per
 * group — around 92 on the measured tenant, and unbounded on a larger one, hence the
 * cap.
 */
export async function loadWholeTree(
  gateway: PlanGateway,
  options: { onProgress?: Progress; concurrency?: number; maxGroups?: number } = {},
): Promise<GroupTree> {
  const concurrency = Math.max(1, options.concurrency ?? 6);
  const maxGroups = options.maxGroups ?? 5_000;

  const tree = await loadRootTree(gateway);
  let frontier = [...tree.roots];
  let loaded = 0;

  while (frontier.length > 0) {
    loaded += frontier.length;
    if (loaded > maxGroups) {
      throw new Error(
        `This tenant has more than ${maxGroups.toLocaleString()} groups, which is more ` +
          `than this export can hold. Build your file from the part of the tree you need.`,
      );
    }

    const next: typeof frontier = [];
    for (let i = 0; i < frontier.length; i += concurrency) {
      const batch = frontier.slice(i, i + concurrency);
      const levels = await Promise.all(
        batch.map(async (node) => ({
          uniqueId: node.uniqueId,
          response: await gateway.groupsTree(node.uniqueId),
        })),
      );
      for (const level of levels) {
        addLevel(tree, level.uniqueId, level.response.treeItems ?? []);
        const parent = tree.byUniqueId.get(level.uniqueId);
        if (parent) next.push(...parent.children);
      }
      options.onProgress?.({ phase: 'tree', done: loaded, total: null });
    }

    frontier = next;
  }

  return tree;
}

/**
 * Load only the parts of the tree the CSV actually refers to, then plan.
 *
 * Loading the whole tree up front would be hundreds of calls against a tenant this
 * size; the planner tells us precisely which branches it needs.
 */
export async function buildGroupPlan(
  gateway: PlanGateway,
  rows: readonly GroupCsvRow[],
  onProgress?: Progress,
): Promise<GroupPlanResult> {
  // A file carrying ids can ask for a group to move, and a group's *current* parent is
  // unknowable without having seen it. Loading only the branches the file names would
  // leave a group that has been moved away looking like one that no longer exists.
  if (rows.some((row) => row.uniqueId !== null)) {
    const tree = await loadWholeTree(gateway, {
      ...(onProgress ? { onProgress } : {}),
    });
    const outcome = planGroups(tree, rows);
    if (outcome.status === 'ok') return { plan: outcome.plan, tree };
    // Nothing is left to load, so a request for more is a bug rather than a state to
    // recover from. Saying so beats looping until MAX_PASSES.
    throw new Error(
      'The whole group tree was loaded but planning still asked for more of it. ' +
        'This is a bug. Please report it.',
    );
  }

  const tree = await loadRootTree(gateway);

  let loaded = 1;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const outcome = planGroups(tree, rows);
    if (outcome.status === 'ok') return { plan: outcome.plan, tree };

    // Levels within a pass are independent, so fetch them together.
    const levels = await Promise.all(
      outcome.uniqueIds.map(async (uniqueId) => ({
        uniqueId,
        response: await gateway.groupsTree(uniqueId),
      })),
    );
    for (const level of levels) {
      addLevel(tree, level.uniqueId, level.response.treeItems ?? []);
    }

    loaded += levels.length;
    onProgress?.({ phase: 'tree', done: loaded, total: null });
  }

  throw new Error(
    `Gave up loading the group tree after ${MAX_PASSES} passes. ` +
      `This usually means a group path is far deeper than expected.`,
  );
}

/**
 * Index every group in the tenant by its unique id.
 *
 * The shortcut file addresses groups by id, so there is no path to walk and no name to
 * match: this is a straight lookup table, built once from a tree the caller has already
 * loaded in full. Its display value is the group's full path, which is the only part
 * of a group a person can actually read back.
 */
export function indexGroupsById(tree: GroupTree): Map<string, ResolvedGroup> {
  const resolved = new Map<string, ResolvedGroup>();

  for (const { uniqueId, path } of allGroups(tree)) {
    const node = tree.byUniqueId.get(uniqueId);
    if (!node) continue;
    resolved.set(uniqueId.toLowerCase(), {
      uniqueId: node.uniqueId,
      id: node.id,
      name: node.title,
      display: displayPath(path),
    });
  }

  return resolved;
}

export interface ShortcutPlanResult {
  plan: ShortcutPlan;
  /** Processes that could not be read at all, keyed by CSV line. */
  unreadable: Array<{ line: number; processUniqueId: string; message: string }>;
  /**
   * Re-plan against the same reads with a different publish choice.
   *
   * Changing that answer changes which processes are blocked as well as how they are
   * written, so it cannot be applied to a finished plan — but nothing in planning does
   * I/O, so re-running it costs nothing and needs no second pass over the tenant.
   */
  replan(options: ShortcutPlanOptions): ShortcutPlan;
}

/**
 * Fetch the current state of every process named in the CSV, then plan.
 *
 * Processes whose rows name no group are skipped before fetching — they cannot change
 * anything, so reading them would be wasted work on a file that is mostly untouched
 * worksheet rows.
 */
export async function buildShortcutPlan(
  gateway: PlanGateway,
  processes: readonly ShortcutCsvProcess[],
  groups: ReadonlyMap<string, ResolvedGroup>,
  options: {
    concurrency?: number;
    onProgress?: Progress;
    published?: PublishedBehaviour | undefined;
  } = {},
): Promise<ShortcutPlanResult> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const unreadable: ShortcutPlanResult['unreadable'] = [];
  const summaries = new Map<string, ProcessSummary>();

  const toFetch = processes.filter((row) => !isNoInstruction(row));
  let done = 0;

  for (let i = 0; i < toFetch.length; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (row) => {
        try {
          summaries.set(row.processId, await gateway.processSummary(row.processId));
        } catch (error) {
          // One unreadable process must not abandon the plan for the other 1,517.
          unreadable.push({
            line: row.line,
            processUniqueId: row.processId,
            message: (error as Error).message,
          });
        }
      }),
    );
    done += batch.length;
    options.onProgress?.({ phase: 'processes', done, total: toFetch.length });
  }

  const deps: ShortcutPlanDeps = {
    resolveGroup: (uniqueId) => groups.get(uniqueId.toLowerCase()) ?? null,
    resolveProcess: (processId): ProcessResolution => {
      const summary = summaries.get(processId);
      if (!summary) return { kind: 'missing' };
      return {
        kind: 'found',
        snapshot: {
          uniqueId: summary.uniqueId,
          name: summary.name,
          version: summary.version,
          revisionEditId: summary.revisionEditId,
          revisionStateId: summary.revisionStateId,
          currentShortcuts: summary.currentShortcuts,
          canEdit: summary.canEdit,
          actions: {
            CanPublish: false,
            CanPublishAfterEdit: summary.canPublishAfterEdit,
            CanSubmitForApproval: false,
            CanSubmitForApprovalAfterEdit: summary.canSubmitForApprovalAfterEdit,
            CanQuickSave: summary.canSave,
            CanSave: summary.canSave,
            CanPublishWithoutComment: false,
            CanSuppressPublishChangeNotification: true,
          },
        },
      };
    },
  };

  const replan = (planOptions: ShortcutPlanOptions): ShortcutPlan =>
    planShortcuts(processes, deps, planOptions);

  return {
    plan: replan({ published: options.published ?? 'save' }),
    unreadable,
    replan,
  };
}
