/**
 * Turning a plan into something a person can approve.
 *
 * The planners answer "what will change"; this module answers "what will the operator
 * see". It is kept pure and separate from the React components for two reasons: the
 * wording of a preview is the last thing standing between a spreadsheet and 1,518
 * republished processes, so it deserves tests; and a plan of that size cannot be read
 * on screen at all, so the same view-model has to render to CSV.
 */

import { toCsv } from '../csv/parse.ts';
import type { CreateParent, GroupPlan, PlanIssue } from '../plan/groupPlan.ts';
import type {
  ResolvedGroup,
  ShortcutChange,
  ShortcutPlan,
  WritePath,
} from '../plan/shortcutPlan.ts';
import { writeCount } from '../plan/shortcutPlan.ts';
import type { ProcessGroupRef } from '../pm/types.ts';

// ------------------------------------------------------------- group plan

export interface GroupPreviewRow {
  seq: number;
  display: string;
  /** Where it will be attached, in plain language. */
  parentLabel: string;
  line: number;
}

export interface GroupPreview {
  creates: GroupPreviewRow[];
  /** Paths in the file that already exist. Counted, not listed — they are the boring case. */
  existingCount: number;
  blocked: PlanIssue[];
  isNoOp: boolean;
}

export function describeCreateParent(parent: CreateParent): string {
  switch (parent.kind) {
    case 'root':
      return 'at the top level';
    case 'existing':
      return `inside ${parent.display}`;
    case 'planned':
      // Worth flagging: this group's parent does not exist yet either, so the create
      // depends on an earlier step of the same run succeeding.
      return `inside ${parent.display} (also new)`;
  }
}

export function buildGroupPreview(plan: GroupPlan): GroupPreview {
  return {
    creates: plan.creates.map((c) => ({
      seq: c.seq,
      display: c.display,
      parentLabel: describeCreateParent(c.parent),
      line: c.line,
    })),
    existingCount: plan.existing.length,
    blocked: plan.blocked,
    isNoOp: plan.creates.length === 0,
  };
}

export function groupPreviewToCsv(preview: GroupPreview): string {
  const rows: string[][] = [['Action', 'Group Path', 'Detail', 'CSV Row']];
  for (const c of preview.creates) {
    rows.push(['Create', c.display, c.parentLabel, String(c.line)]);
  }
  for (const b of preview.blocked) {
    rows.push(['Blocked', b.display, b.message, String(b.line)]);
  }
  return toCsv(rows);
}

// ---------------------------------------------------------- shortcut plan

export interface ShortcutDiff {
  /** Shortcuts being added, by the path the operator wrote. */
  added: Array<{ display: string; isNewGroup: boolean }>;
  /**
   * Shortcuts being removed. Only the group's own name is available — Process Manager
   * reports a shortcut as an id and a leaf name, never a full path.
   */
  removed: string[];
  /** Shortcuts present before and after. */
  kept: string[];
}

export function diffShortcuts(
  current: readonly ProcessGroupRef[],
  desired: readonly ResolvedGroup[],
): ShortcutDiff {
  const currentIds = new Set(current.map((s) => s.UniqueId));
  // A group that does not exist yet has no id, so it can never be "kept".
  const desiredIds = new Set(desired.map((g) => g.uniqueId).filter((id): id is string => id !== null));

  const added: ShortcutDiff['added'] = [];
  const kept: string[] = [];

  for (const group of desired) {
    if (group.uniqueId !== null && currentIds.has(group.uniqueId)) {
      kept.push(group.display);
    } else {
      added.push({ display: group.display, isNewGroup: group.uniqueId === null });
    }
  }

  const removed = current.filter((s) => !desiredIds.has(s.UniqueId)).map((s) => s.Name);

  return { added, removed, kept };
}

export function describeWritePath(writePath: WritePath): string {
  switch (writePath.kind) {
    case 'save-only':
      return 'Saves a draft. Nothing is published.';
    case 'publish-direct':
      return 'Publishes a new major version.';
    case 'submit-then-publish':
      return 'Submits for approval, then publishes a new major version.';
  }
}

/**
 * The version the process is expected to end on.
 *
 * From the observed lifecycle (DESIGN.md): an edit bumps the minor version, and
 * publishing bumps the major and resets the minor. Labelled "expected" wherever it is
 * shown — it is derived from behaviour, not from a documented guarantee.
 */
export function expectedVersion(version: string, writePath: WritePath): string | null {
  const match = /^(\d+)\.(\d+)$/.exec(version.trim());
  if (!match) return null;

  const major = Number(match[1]);
  const minor = Number(match[2]);

  if (writePath.kind === 'save-only') return `${major}.${minor + 1}`;
  return `${major + 1}.0`;
}

export interface ShortcutPreviewRow {
  line: number;
  processUniqueId: string;
  processName: string;
  version: string;
  expectedVersion: string | null;
  diff: ShortcutDiff;
  effect: string;
  publishes: boolean;
}

export interface ShortcutPreviewCounts {
  updates: number;
  clears: number;
  unchanged: number;
  blocked: number;
  /** Changes that will produce a new published major version. The number that matters. */
  publishes: number;
  /** Changes that only save a draft. */
  drafts: number;
}

export interface ShortcutPreview {
  updates: ShortcutPreviewRow[];
  /** Kept apart from updates: removing every shortcut needs its own confirmation. */
  clears: ShortcutPreviewRow[];
  blocked: ShortcutPlan['blocked'];
  warnings: ShortcutPlan['warnings'];
  counts: ShortcutPreviewCounts;
  /** Total PM writes implied — publishes cost two or three requests, not one. */
  writes: number;
  isNoOp: boolean;
}

function toRow(change: ShortcutChange): ShortcutPreviewRow {
  return {
    line: change.line,
    processUniqueId: change.processUniqueId,
    processName: change.processName,
    version: change.version,
    expectedVersion: expectedVersion(change.version, change.writePath),
    diff: diffShortcuts(change.currentShortcuts, change.desired),
    effect: describeWritePath(change.writePath),
    publishes: change.writePath.kind !== 'save-only',
  };
}

export function buildShortcutPreview(plan: ShortcutPlan): ShortcutPreview {
  const byLine = (a: { line: number }, b: { line: number }): number => a.line - b.line;

  const updates = plan.updates.map(toRow).sort(byLine);
  const clears = plan.clears.map(toRow).sort(byLine);
  const all = [...updates, ...clears];

  const publishes = all.filter((r) => r.publishes).length;

  return {
    updates,
    clears,
    blocked: plan.blocked,
    warnings: plan.warnings,
    counts: {
      updates: updates.length,
      clears: clears.length,
      unchanged: plan.unchanged.length,
      blocked: plan.blocked.length,
      publishes,
      drafts: all.length - publishes,
    },
    writes: writeCount(plan),
    isNoOp: all.length === 0,
  };
}

/** True when the operator must confirm a second time before applying. */
export function requiresClearConfirmation(preview: ShortcutPreview): boolean {
  return preview.clears.length > 0;
}

const SHORTCUT_JOIN = '; ';

export function shortcutPreviewToCsv(preview: ShortcutPreview): string {
  const rows: string[][] = [
    [
      'Action',
      'Process Unique Id',
      'Process Name',
      'Current Version',
      'Expected Version',
      'Adding',
      'Removing',
      'Keeping',
      'Effect',
      'CSV Row',
    ],
  ];

  const push = (action: string, r: ShortcutPreviewRow): void => {
    rows.push([
      action,
      r.processUniqueId,
      r.processName,
      r.version,
      r.expectedVersion ?? '',
      r.diff.added.map((a) => (a.isNewGroup ? `${a.display} (new)` : a.display)).join(SHORTCUT_JOIN),
      r.diff.removed.join(SHORTCUT_JOIN),
      r.diff.kept.join(SHORTCUT_JOIN),
      r.effect,
      String(r.line),
    ]);
  };

  for (const r of preview.updates) push('Update', r);
  for (const r of preview.clears) push('Clear', r);
  for (const b of preview.blocked) {
    rows.push([
      'Blocked',
      b.processUniqueId ?? '',
      b.processName,
      '',
      '',
      '',
      '',
      '',
      b.reason,
      String(b.line),
    ]);
  }

  return toCsv(rows);
}
