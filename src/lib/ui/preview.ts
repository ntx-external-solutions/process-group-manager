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
import { isNoOp, type CreateParent, type GroupPlan, type PlanIssue } from '../plan/groupPlan.ts';
import type {
  ResolvedGroup,
  ShortcutChange,
  ShortcutPlan,
  WritePath,
} from '../plan/shortcutPlan.ts';
import { writeCount } from '../plan/shortcutPlan.ts';
import { expectedVersion as expectedVersionOf } from '../plan/version.ts';
import type { ProcessGroupRef } from '../pm/types.ts';

// ------------------------------------------------------------- group plan

export interface GroupPreviewRow {
  seq: number;
  display: string;
  /** Where it will be attached, in plain language. */
  parentLabel: string;
  line: number;
}

export interface GroupMatchRow {
  display: string;
  /** The group the path actually resolved to. */
  uniqueId: string;
  line: number;
}

export interface GroupRenameRow {
  uniqueId: string;
  fromDisplay: string;
  from: string;
  to: string;
  line: number;
}

export interface GroupMoveRow {
  uniqueId: string;
  name: string;
  fromDisplay: string;
  toDisplay: string;
  /** True when the destination is a group this same run creates. */
  intoNewParent: boolean;
  line: number;
}

export interface GroupPreview {
  creates: GroupPreviewRow[];
  /**
   * Kept apart from creates, and from each other. "12 groups changed" is not something
   * anyone can approve: creating a group adds to the tree, but moving one takes its
   * processes and its permissions with it, and renaming one changes what everybody
   * else's links and bookmarks say.
   */
  renames: GroupRenameRow[];
  moves: GroupMoveRow[];
  /** Paths in the file that already exist. Counted on screen, listed in the download. */
  existing: GroupMatchRow[];
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
    renames: [...plan.renames].sort((a, b) => a.line - b.line),
    moves: [...plan.moves]
      .sort((a, b) => a.line - b.line)
      .map((m) => ({
        uniqueId: m.uniqueId,
        name: m.name,
        fromDisplay: m.fromDisplay,
        toDisplay: m.toDisplay,
        intoNewParent: m.toParent.kind === 'planned',
        line: m.line,
      })),
    existing: [...plan.existing]
      .sort((a, b) => a.line - b.line)
      .map((e) => ({ display: e.display, uniqueId: e.uniqueId, line: e.line })),
    existingCount: plan.existing.length,
    blocked: plan.blocked,
    isNoOp: isNoOp(plan),
  };
}

/**
 * The full plan, including the rows that matched something that already exists.
 *
 * Those are counted rather than listed on screen — they are the boring case — but they
 * belong in the downloadable artefact, each with the id its path resolved to. That is
 * what someone checks when they want to be sure a row pointed at the group they meant,
 * which is the whole reason the id column exists.
 */
export function groupPreviewToCsv(preview: GroupPreview): string {
  const rows: string[][] = [
    ['Action', 'Group Path', 'Group Unique Id', 'Detail', 'CSV Row'],
  ];
  for (const c of preview.creates) {
    // No id yet — it does not exist until the run creates it.
    rows.push(['Create', c.display, '', c.parentLabel, String(c.line)]);
  }
  for (const r of preview.renames) {
    rows.push([
      'Rename',
      r.fromDisplay,
      r.uniqueId,
      `"${r.from}" becomes "${r.to}"`,
      String(r.line),
    ]);
  }
  for (const m of preview.moves) {
    rows.push([
      'Move',
      m.fromDisplay,
      m.uniqueId,
      `to ${m.toDisplay}${m.intoNewParent ? ' (new parent)' : ''}`,
      String(m.line),
    ]);
  }
  for (const e of preview.existing) {
    rows.push(['Already exists', e.display, e.uniqueId, '', String(e.line)]);
  }
  for (const b of preview.blocked) {
    rows.push(['Blocked', b.display, '', b.message, String(b.line)]);
  }
  return toCsv(rows);
}

// ---------------------------------------------------------- shortcut plan

export interface ShortcutDiff {
  /** Shortcuts being added, by the full path of the group. */
  added: string[];
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
  const currentIds = new Set(current.map((s) => s.UniqueId.toLowerCase()));
  const desiredIds = new Set(desired.map((g) => g.uniqueId.toLowerCase()));

  const added: string[] = [];
  const kept: string[] = [];

  for (const group of desired) {
    if (currentIds.has(group.uniqueId.toLowerCase())) kept.push(group.display);
    else added.push(group.display);
  }

  const removed = current
    .filter((s) => !desiredIds.has(s.UniqueId.toLowerCase()))
    .map((s) => s.Name);

  return { added, removed, kept };
}

/**
 * What a write does, in the operator's terms.
 *
 * A save on a published process is not the same event as a save on one already in
 * progress. Calling both "saves a draft" hid the two things people actually ask about:
 * that a live version keeps its old shortcuts until somebody publishes, and that a
 * process already in progress was never going to publish whatever was chosen.
 */
export function describeWritePath(writePath: WritePath, fromPublished = false): string {
  switch (writePath.kind) {
    case 'save-only':
      return fromPublished
        ? 'Saves a draft. The published version keeps its current shortcuts.'
        : 'Already in progress, so it is saved. Nothing to republish.';
    case 'publish-direct':
      return 'Publishes a new major version.';
    case 'submit-then-publish':
      return 'Submits for approval, then publishes a new major version.';
  }
}

export { expectedVersion } from '../plan/version.ts';

export interface ShortcutPreviewRow {
  line: number;
  /** Every row of the file that fed this change, for the downloadable plan. */
  lines: number[];
  processUniqueId: string;
  processName: string;
  version: string;
  expectedVersion: string | null;
  diff: ShortcutDiff;
  effect: string;
  publishes: boolean;
  /** Published today, so a save leaves the live version behind. */
  fromPublished: boolean;
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
  /** Drafts that sit on top of a published version, which is the surprising case. */
  draftsOnPublished: number;
  /**
   * Changes to processes already in progress. They are saved under either choice, so
   * this is the number that explains why picking "match state" published fewer
   * processes than the file names.
   */
  inProgress: number;
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
  /** The publish choice this preview was built from. */
  publish: ShortcutPlan['publish'];
  isNoOp: boolean;
}

function toRow(change: ShortcutChange): ShortcutPreviewRow {
  return {
    line: change.line,
    lines: change.lines,
    processUniqueId: change.processUniqueId,
    processName: change.processName,
    version: change.version,
    expectedVersion: expectedVersionOf(change.version, change.writePath),
    diff: diffShortcuts(change.currentShortcuts, change.desired),
    effect: describeWritePath(change.writePath, change.fromPublished),
    publishes: change.writePath.kind !== 'save-only',
    fromPublished: change.fromPublished,
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
      draftsOnPublished: all.filter((r) => !r.publishes && r.fromPublished).length,
      inProgress: all.filter((r) => !r.fromPublished).length,
    },
    writes: writeCount(plan),
    publish: plan.publish,
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
      'CSV Rows',
    ],
  ];

  const push = (action: string, r: ShortcutPreviewRow): void => {
    rows.push([
      action,
      r.processUniqueId,
      r.processName,
      r.version,
      r.expectedVersion ?? '',
      r.diff.added.join(SHORTCUT_JOIN),
      r.diff.removed.join(SHORTCUT_JOIN),
      r.diff.kept.join(SHORTCUT_JOIN),
      r.effect,
      // A process gathers its shortcuts from several rows, so citing one would send
      // whoever checks the plan to an arbitrary line of the file.
      r.lines.join(', '),
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
