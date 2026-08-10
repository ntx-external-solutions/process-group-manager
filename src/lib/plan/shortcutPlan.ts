/**
 * Shortcut planner. Replace semantics: the CSV wins for the data it contains.
 *
 * Pure function of (parsed rows, resolvers) -> plan. Decides *what* changes and *how*
 * it must be written, but performs no I/O — the object it returns is both what the
 * operator approves in the preview and what the executor runs.
 */

import type { CsvIssue } from '../csv/groups.ts';
import type { ShortcutCsvRow } from '../csv/shortcuts.ts';
import type { ProcessActions, ProcessRevisionStateId } from '../pm/types.ts';

/** A group that shortcuts can point at. */
export interface ResolvedGroup {
  /** null when this group does not exist yet and will be created earlier in the run. */
  uniqueId: string | null;
  /** Index into the group plan's creates, when uniqueId is null. */
  plannedSeq: number | null;
  name: string;
  display: string;
}

/** The live state of a process, as read before planning. */
export interface ProcessSnapshot {
  uniqueId: string;
  name: string;
  version: string;
  revisionEditId: number;
  revisionStateId: ProcessRevisionStateId;
  /** Group uniqueIds currently set as shortcuts. */
  currentShortcutIds: string[];
  actions: ProcessActions;
  canEdit: boolean;
}

export type ProcessResolution =
  | { kind: 'found'; snapshot: ProcessSnapshot }
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: string[] };

export interface ShortcutPlanDeps {
  /** Look up a group by its path key (see csv/path.ts pathKey). */
  resolveGroup(key: string): ResolvedGroup | null;
  resolveProcess(row: ShortcutCsvRow): ProcessResolution;
}

/**
 * How a change must be written, derived from the process state and the caller's
 * permissions on it (DESIGN.md "Publishing").
 */
export type WritePath =
  /** In progress: one PUT, no publish. Minor version bump only. */
  | { kind: 'save-only' }
  /** Published and the user may publish straight after editing. */
  | { kind: 'publish-direct' }
  /** Published; must pass through submit-for-approval first. The proven recipe. */
  | { kind: 'submit-then-publish' };

export interface ShortcutChange {
  line: number;
  processUniqueId: string;
  processName: string;
  version: string;
  revisionEditId: number;
  /** Desired final shortcut set. Empty for a clear. */
  desired: ResolvedGroup[];
  currentShortcutIds: string[];
  writePath: WritePath;
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
  clears: ShortcutChange[];
  unchanged: ShortcutUnchanged[];
  blocked: ShortcutBlocked[];
  warnings: CsvIssue[];
}

export function planShortcuts(
  rows: readonly ShortcutCsvRow[],
  deps: ShortcutPlanDeps,
): ShortcutPlan {
  const plan: ShortcutPlan = {
    updates: [],
    clears: [],
    unchanged: [],
    blocked: [],
    warnings: [],
  };

  for (const row of rows) {
    const label = row.processName ?? row.processId ?? `row ${row.line}`;

    // A row with no shortcut data is a no-op regardless of anything else, so it is
    // not worth resolving the process or reporting permission problems for it.
    if (row.intent.kind === 'none') {
      plan.unchanged.push({
        line: row.line,
        processUniqueId: row.processId ?? '',
        processName: label,
        reason: 'no-data',
      });
      continue;
    }

    const resolution = deps.resolveProcess(row);
    if (resolution.kind === 'missing') {
      plan.blocked.push({
        line: row.line,
        processUniqueId: row.processId,
        processName: label,
        reason: 'No matching process found in Process Manager.',
      });
      continue;
    }
    if (resolution.kind === 'ambiguous') {
      plan.blocked.push({
        line: row.line,
        processUniqueId: null,
        processName: label,
        reason:
          `"${label}" matches ${resolution.candidates.length} processes. ` +
          `Add a Process ID column to identify the one you mean.`,
      });
      continue;
    }

    const snapshot = resolution.snapshot;

    if (row.processName && row.processName !== snapshot.name) {
      // Names drift; the ID is authoritative. Worth surfacing, not worth failing on.
      plan.warnings.push({
        line: row.line,
        message:
          `Row ${row.line} says "${row.processName}" but the process is now named ` +
          `"${snapshot.name}". Using the Process ID.`,
      });
    }

    const desired = resolveTargets(row, deps, plan, label);
    if (desired === null) continue;

    if (setsMatch(snapshot.currentShortcutIds, desired)) {
      plan.unchanged.push({
        line: row.line,
        processUniqueId: snapshot.uniqueId,
        processName: snapshot.name,
        reason: 'already-matches',
      });
      continue;
    }

    const writePath = chooseWritePath(snapshot);
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
      processUniqueId: snapshot.uniqueId,
      processName: snapshot.name,
      version: snapshot.version,
      revisionEditId: snapshot.revisionEditId,
      desired,
      currentShortcutIds: snapshot.currentShortcutIds,
      writePath,
    };

    if (row.intent.kind === 'clear') plan.clears.push(change);
    else plan.updates.push(change);
  }

  return plan;
}

/** Resolve every shortcut path in a row, or record a block and return null. */
function resolveTargets(
  row: ShortcutCsvRow,
  deps: ShortcutPlanDeps,
  plan: ShortcutPlan,
  label: string,
): ResolvedGroup[] | null {
  if (row.intent.kind !== 'set') return [];

  const out: ResolvedGroup[] = [];
  for (const target of row.intent.targets) {
    const group = deps.resolveGroup(target.key);
    if (!group) {
      plan.blocked.push({
        line: row.line,
        processUniqueId: row.processId,
        processName: label,
        reason:
          `Shortcut group "${target.display}" does not exist. ` +
          `Create it first, or add it to the group-structure file.`,
      });
      return null;
    }
    out.push(group);
  }
  return out;
}

/**
 * Compare current shortcuts against the desired set.
 *
 * Groups that do not exist yet can never match current state, so a plan containing
 * one is always a change.
 */
function setsMatch(currentIds: readonly string[], desired: readonly ResolvedGroup[]): boolean {
  if (desired.some((g) => g.uniqueId === null)) return false;
  if (currentIds.length !== desired.length) return false;
  const current = new Set(currentIds);
  return desired.every((g) => current.has(g.uniqueId as string));
}

/** Returns a WritePath, or a plain-language reason the process cannot be written. */
function chooseWritePath(snapshot: ProcessSnapshot): WritePath | string {
  if (!snapshot.canEdit) {
    return 'You do not have permission to edit this process.';
  }

  if (snapshot.revisionStateId === 2) {
    // Someone else is mid-review. Editing underneath them is not ours to do.
    return 'Awaiting approval — not modified.';
  }

  if (snapshot.revisionStateId === 1) {
    return { kind: 'save-only' };
  }

  // Published.
  if (!snapshot.actions.CanSave) {
    return 'You do not have permission to save changes to this process.';
  }
  if (snapshot.actions.CanPublishAfterEdit) {
    return { kind: 'publish-direct' };
  }
  if (snapshot.actions.CanSubmitForApprovalAfterEdit) {
    return { kind: 'submit-then-publish' };
  }
  return (
    'Published, but you can neither publish nor submit it for approval, ' +
    'so the change could not be completed.'
  );
}

/** True when the plan would write nothing. */
export function isNoOp(plan: ShortcutPlan): boolean {
  return plan.updates.length === 0 && plan.clears.length === 0;
}

/** Total PM writes the plan implies, for progress and runtime estimates. */
export function writeCount(plan: ShortcutPlan): number {
  return [...plan.updates, ...plan.clears].reduce((n, c) => {
    if (c.writePath.kind === 'save-only') return n + 1;
    if (c.writePath.kind === 'publish-direct') return n + 2;
    return n + 3;
  }, 0);
}
