/**
 * Shortcut planner. Additive semantics: the file adds what it names, and takes nothing
 * away unless a row says so.
 *
 * Pure function of (parsed processes, resolvers, options) -> plan. Decides *what*
 * changes and *how* it must be written, but performs no I/O — the object it returns is
 * both what the operator approves in the preview and what the executor runs.
 *
 * Two things it owns that are easy to miss:
 *
 *  - **Every row for a process is already folded together** by the parser, so a process
 *    is planned once, written once, and versioned once however many groups it gains.
 *  - **Whether a published process is republished is the operator's call**, not a
 *    property of the process. `options.published` carries that decision, and re-planning
 *    with a different answer is cheap because nothing here does I/O.
 */

import type { CsvIssue } from '../csv/groups.ts';
import type { ShortcutCsvProcess } from '../csv/shortcuts.ts';
import { isNoInstruction } from '../csv/shortcuts.ts';
import type { ProcessActions, ProcessGroupRef, ProcessRevisionStateId } from '../pm/types.ts';

/** A group that shortcuts can point at. Always one that exists — ids cannot be planned. */
export interface ResolvedGroup {
  uniqueId: string;
  /** Process Manager's numeric group id. The write payload needs both. */
  id: number;
  name: string;
  /** Full path, for the preview. Falls back to the name when the path is unknown. */
  display: string;
}

/** The live state of a process, as read before planning. */
export interface ProcessSnapshot {
  uniqueId: string;
  name: string;
  version: string;
  revisionEditId: number;
  revisionStateId: ProcessRevisionStateId;
  /** Groups currently set as shortcuts. Named, so a preview can be read. */
  currentShortcuts: ProcessGroupRef[];
  actions: ProcessActions;
  canEdit: boolean;
}

export type ProcessResolution =
  | { kind: 'found'; snapshot: ProcessSnapshot }
  | { kind: 'missing' };

export interface ShortcutPlanDeps {
  /** Look up a group by its unique id, lower-cased. */
  resolveGroup(uniqueId: string): ResolvedGroup | null;
  resolveProcess(processId: string): ProcessResolution;
}

/**
 * What to do with a process that is currently published.
 *
 * `republish` puts the change live and burns a major version; `save` leaves the change
 * as an unpublished draft on top of the published version. Drafts and in-progress
 * revisions are unaffected by this — they are only ever saved (PLAN.md §5.3).
 */
export type PublishedBehaviour = 'republish' | 'save';

export interface ShortcutPlanOptions {
  published?: PublishedBehaviour | undefined;
}

/**
 * How a change must be written, derived from the process state, the operator's choice,
 * and their permissions on it (DESIGN.md "Publishing").
 */
export type WritePath =
  /** One PUT, no publish. Minor version bump only. */
  | { kind: 'save-only' }
  /** Published and the user may publish straight after editing. */
  | { kind: 'publish-direct' }
  /** Published; must pass through submit-for-approval first. The proven recipe. */
  | { kind: 'submit-then-publish' };

export interface ShortcutChange {
  /** The first row naming this process. */
  line: number;
  /** Every row naming it. A process gains several shortcuts from several rows. */
  lines: number[];
  processUniqueId: string;
  processName: string;
  version: string;
  revisionEditId: number;
  /** Desired final shortcut set. Empty for a clear. */
  desired: ResolvedGroup[];
  currentShortcuts: ProcessGroupRef[];
  writePath: WritePath;
  /**
   * The process is published today. With `published: 'save'` that makes the write a
   * draft sitting on top of a live version, which reads very differently from the same
   * write on a process that was already in progress.
   */
  fromPublished: boolean;
}

export interface ShortcutUnchanged {
  line: number;
  processUniqueId: string;
  processName: string;
  reason: 'already-matches' | 'no-data';
}

export interface ShortcutBlocked {
  line: number;
  processUniqueId: string | null;
  processName: string;
  reason: string;
}

export interface ShortcutPlan {
  updates: ShortcutChange[];
  /** Changes that end with no shortcuts at all. Their own category, own confirmation. */
  clears: ShortcutChange[];
  unchanged: ShortcutUnchanged[];
  blocked: ShortcutBlocked[];
  warnings: CsvIssue[];
  /** The behaviour this plan was built with, so the preview cannot describe another. */
  published: PublishedBehaviour;
}

export function planShortcuts(
  processes: readonly ShortcutCsvProcess[],
  deps: ShortcutPlanDeps,
  options: ShortcutPlanOptions = {},
): ShortcutPlan {
  const published = options.published ?? 'save';
  const plan: ShortcutPlan = {
    updates: [],
    clears: [],
    unchanged: [],
    blocked: [],
    warnings: [],
    published,
  };

  for (const row of processes) {
    const label = row.processName ?? row.processId;

    // A row naming no group is a no-op regardless of anything else, so it is not worth
    // resolving the process or reporting permission problems for it.
    if (isNoInstruction(row)) {
      plan.unchanged.push({
        line: row.line,
        processUniqueId: row.processId,
        processName: label,
        reason: 'no-data',
      });
      continue;
    }

    const resolution = deps.resolveProcess(row.processId);
    if (resolution.kind === 'missing') {
      plan.blocked.push({
        line: row.line,
        processUniqueId: row.processId,
        processName: label,
        reason: 'No matching process found in Process Manager.',
      });
      continue;
    }

    const snapshot = resolution.snapshot;

    if (row.processName && row.processName !== snapshot.name) {
      // Names drift; the id is authoritative. Worth surfacing, not worth failing on.
      plan.warnings.push({
        line: row.line,
        message:
          `Row ${row.line} says "${row.processName}" but the process is now named ` +
          `"${snapshot.name}". Matched on the id, not the name.`,
      });
    }

    const desired = resolveDesired(row, snapshot, deps, plan, label);
    if (desired === null) continue;

    if (setsMatch(snapshot.currentShortcuts, desired)) {
      plan.unchanged.push({
        line: row.line,
        processUniqueId: snapshot.uniqueId,
        processName: snapshot.name,
        reason: 'already-matches',
      });
      continue;
    }

    const writePath = chooseWritePath(snapshot, published);
    if (typeof writePath === 'string') {
      plan.blocked.push({
        line: row.line,
        processUniqueId: snapshot.uniqueId,
        processName: snapshot.name,
        reason: writePath,
      });
      continue;
    }

    const change: ShortcutChange = {
      line: row.line,
      lines: row.lines,
      processUniqueId: snapshot.uniqueId,
      processName: snapshot.name,
      version: snapshot.version,
      revisionEditId: snapshot.revisionEditId,
      desired,
      currentShortcuts: snapshot.currentShortcuts,
      writePath,
      fromPublished: snapshot.revisionStateId === 3,
    };

    if (desired.length === 0) plan.clears.push(change);
    else plan.updates.push(change);
  }

  return plan;
}

/**
 * Work out the shortcut set the process should end with.
 *
 * Starts from what it already has, because the file is additive: anything it does not
 * mention survives. Returns null when a row cannot be resolved and the process has been
 * blocked instead.
 */
function resolveDesired(
  row: ShortcutCsvProcess,
  snapshot: ProcessSnapshot,
  deps: ShortcutPlanDeps,
  plan: ShortcutPlan,
  label: string,
): ResolvedGroup[] | null {
  const block = (reason: string): null => {
    plan.blocked.push({
      line: row.line,
      processUniqueId: row.processId,
      processName: label,
      reason,
    });
    return null;
  };

  /** uniqueId -> group, in the order they will be written. */
  const desired = new Map<string, ResolvedGroup>();

  if (!row.clear) {
    for (const current of snapshot.currentShortcuts) {
      const key = current.UniqueId.toLowerCase();
      // Kept as-is rather than re-resolved: a shortcut into a group we cannot see in
      // the tree is still one the process has, and dropping it would silently remove it.
      desired.set(key, {
        uniqueId: current.UniqueId,
        id: current.Id,
        name: current.Name,
        display: current.Name,
      });
    }
  }

  for (const id of row.add) {
    const group = deps.resolveGroup(id);
    if (!group) {
      return block(
        `Group ${id} was not found in your tenant. Check the id against the group ` +
          `hierarchy download.`,
      );
    }
    desired.set(group.uniqueId.toLowerCase(), group);
  }

  for (const id of row.remove) {
    const key = id.toLowerCase();
    if (!desired.delete(key)) {
      const group = deps.resolveGroup(id);
      plan.warnings.push({
        line: row.line,
        message:
          `Row ${row.line}: "${snapshot.name}" is not shortcut into ` +
          `${group ? `"${group.display}"` : `group ${id}`}, so there is nothing to remove.`,
      });
    }
  }

  return [...desired.values()];
}

/** Compare current shortcuts against the desired set, as a set of group ids. */
function setsMatch(
  currentShortcuts: readonly ProcessGroupRef[],
  desired: readonly ResolvedGroup[],
): boolean {
  if (currentShortcuts.length !== desired.length) return false;
  const current = new Set(currentShortcuts.map((s) => s.UniqueId.toLowerCase()));
  return desired.every((g) => current.has(g.uniqueId.toLowerCase()));
}

/** Returns a WritePath, or a plain-language reason the process cannot be written. */
function chooseWritePath(
  snapshot: ProcessSnapshot,
  published: PublishedBehaviour,
): WritePath | string {
  if (!snapshot.canEdit) {
    return 'You do not have permission to edit this process.';
  }

  if (snapshot.revisionStateId === 2) {
    // Someone else is mid-review. Editing underneath them is not ours to do.
    return 'Awaiting approval, so it was not modified.';
  }

  // A draft (0.x) or an in-progress revision (x.y) is only ever saved. It has no
  // published version to disturb, and publishing one was never what the file asked for.
  if (snapshot.revisionStateId === 1) {
    return { kind: 'save-only' };
  }

  // Published.
  if (!snapshot.actions.CanSave) {
    return 'You do not have permission to save changes to this process.';
  }
  if (published === 'save') {
    // The published version keeps its current shortcuts; the change waits as a draft.
    return { kind: 'save-only' };
  }
  if (snapshot.actions.CanPublishAfterEdit) {
    return { kind: 'publish-direct' };
  }
  if (snapshot.actions.CanSubmitForApprovalAfterEdit) {
    return { kind: 'submit-then-publish' };
  }
  return (
    'Published, but you can neither publish it nor submit it for approval. ' +
    'Choose "Save without publishing" to leave the change as a draft instead.'
  );
}

/** True when the plan would write nothing. */
export function isNoOp(plan: ShortcutPlan): boolean {
  return plan.updates.length === 0 && plan.clears.length === 0;
}

/** Processes this plan would republish. The number that matters most on the preview. */
export function publishCount(plan: ShortcutPlan): number {
  return [...plan.updates, ...plan.clears].filter((c) => c.writePath.kind !== 'save-only').length;
}

/** Total PM writes the plan implies, for progress and runtime estimates. */
export function writeCount(plan: ShortcutPlan): number {
  return [...plan.updates, ...plan.clears].reduce((n, c) => {
    if (c.writePath.kind === 'save-only') return n + 1;
    if (c.writePath.kind === 'publish-direct') return n + 2;
    return n + 3;
  }, 0);
}
