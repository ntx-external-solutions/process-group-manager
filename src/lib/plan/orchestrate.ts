/**
 * Turning planners into a dry run.
 *
 * The planners are pure functions over an already-loaded tree. This module owns the
 * awkward part: the group tree only loads one level per call, so planning and loading
 * have to alternate until the plan stops asking for more.
 *
 * Everything here reads. Nothing in this file writes to Process Manager.
 */

import { pathKey } from '../csv/path.ts';
import type { GroupCsvRow } from '../csv/groups.ts';
import type { ShortcutCsvRow } from '../csv/shortcuts.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type { ChildTreeItemsResponse } from '../pm/types.ts';
import { addLevel, emptyTree, resolvePath, type GroupTree } from './tree.ts';
import { planGroups, type CreateAction, type GroupPlan } from './groupPlan.ts';
import {
  planShortcuts,
  type ProcessResolution,
  type ResolvedGroup,
  type ShortcutPlan,
} from './shortcutPlan.ts';

/** The reads this module needs. Implemented over the proxy in the browser. */
export interface PlanGateway {
  groupsTree(parentUniqueId: string | null): Promise<ChildTreeItemsResponse>;
  processSummary(processUniqueId: string): Promise<ProcessSummary>;
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
  const tree = emptyTree();
  const root = await gateway.groupsTree(null);
  addLevel(tree, null, root.treeItems ?? []);

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
 * Resolve every shortcut target named in the CSV.
 *
 * Targets may be groups that already exist, or groups this same run is about to
 * create — the latter resolve to a plan sequence rather than a uniqueId, which is
 * what lets a single upload create a group and point shortcuts at it.
 */
export async function resolveShortcutTargets(
  gateway: PlanGateway,
  rows: readonly ShortcutCsvRow[],
  tree: GroupTree,
  creates: readonly CreateAction[],
): Promise<Map<string, ResolvedGroup>> {
  const wanted = new Map<string, string[]>();
  for (const row of rows) {
    if (row.intent.kind !== 'set') continue;
    for (const target of row.intent.targets) {
      wanted.set(target.key, target.segments);
    }
  }

  const plannedByKey = new Map<string, CreateAction>();
  for (const create of creates) plannedByKey.set(pathKey(create.path), create);

  const resolved = new Map<string, ResolvedGroup>();

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const needed = new Set<string>();

    for (const [key, segments] of wanted) {
      if (resolved.has(key)) continue;

      const planned = plannedByKey.get(key);
      if (planned) {
        resolved.set(key, {
          uniqueId: null,
          plannedSeq: planned.seq,
          name: planned.name,
          display: planned.display,
        });
        continue;
      }

      const outcome = resolvePath(tree, segments);
      if (outcome.kind === 'found') {
        resolved.set(key, {
          uniqueId: outcome.node.uniqueId,
          plannedSeq: null,
          name: outcome.node.title,
          display: segments.join(' | '),
        });
      } else if (outcome.kind === 'unloaded' && outcome.parent) {
        needed.add(outcome.parent.uniqueId);
      }
      // 'missing', 'ambiguous' and 'documentGroup' stay unresolved; the shortcut
      // planner reports them per row, where the CSV line number is known.
    }

    if (needed.size === 0) return resolved;

    const levels = await Promise.all(
      [...needed].map(async (uniqueId) => ({
        uniqueId,
        response: await gateway.groupsTree(uniqueId),
      })),
    );
    for (const level of levels) {
      addLevel(tree, level.uniqueId, level.response.treeItems ?? []);
    }
  }

  return resolved;
}

export interface ShortcutPlanResult {
  plan: ShortcutPlan;
  /** Processes that could not be read at all, keyed by CSV line. */
  unreadable: Array<{ line: number; processUniqueId: string; message: string }>;
}

/**
 * Fetch the current state of every process named in the CSV, then plan.
 *
 * Rows with no shortcut data are skipped before fetching — a blank row cannot change
 * anything, so reading the process would be wasted work on a file that is mostly
 * untouched exported rows.
 */
export async function buildShortcutPlan(
  gateway: PlanGateway,
  rows: readonly ShortcutCsvRow[],
  groups: ReadonlyMap<string, ResolvedGroup>,
  options: { concurrency?: number; onProgress?: Progress } = {},
): Promise<ShortcutPlanResult> {
  const concurrency = Math.max(1, options.concurrency ?? 4);
  const unreadable: ShortcutPlanResult['unreadable'] = [];
  const summaries = new Map<string, ProcessSummary>();

  const toFetch = rows.filter((row) => row.intent.kind !== 'none' && row.processId !== null);
  let done = 0;

  for (let i = 0; i < toFetch.length; i += concurrency) {
    const batch = toFetch.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (row) => {
        const id = row.processId as string;
        try {
          summaries.set(id, await gateway.processSummary(id));
        } catch (error) {
          // One unreadable process must not abandon the plan for the other 1,517.
          unreadable.push({
            line: row.line,
            processUniqueId: id,
            message: (error as Error).message,
          });
        }
      }),
    );
    done += batch.length;
    options.onProgress?.({ phase: 'processes', done, total: toFetch.length });
  }

  const plan = planShortcuts(rows, {
    resolveGroup: (key) => groups.get(key) ?? null,
    resolveProcess: (row): ProcessResolution => {
      if (row.processId === null) {
        // Name-based resolution needs a tenant-wide process index, which v1 does not
        // build. The export always carries IDs, so this is the unusual path.
        return { kind: 'missing' };
      }
      const summary = summaries.get(row.processId);
      if (!summary) return { kind: 'missing' };
      return {
        kind: 'found',
        snapshot: {
          uniqueId: summary.uniqueId,
          name: summary.name,
          version: summary.version,
          revisionEditId: summary.revisionEditId,
          revisionStateId: summary.revisionStateId,
          currentShortcutIds: summary.currentShortcutIds,
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
  });

  return { plan, unreadable };
}
