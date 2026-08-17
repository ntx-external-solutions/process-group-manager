/**
 * The executor. Everything above this file reads; this is where writes happen.
 *
 * It consumes the same plan object the operator approved on the preview screen, so
 * there is no second derivation of "what to do" that could disagree with what they
 * saw. Its rules, in order of how much they matter:
 *
 *  1. **Nothing outside the plan is ever touched.** The runner has no search, no
 *     discovery, and no fallback: it walks the plan and stops.
 *  2. **A step is attempted at most once.** Identity comes from the journal, so a
 *     resume continues rather than repeating. A write whose outcome is unknown is
 *     never blindly retried — it is reconciled against the tenant first.
 *  3. **Concurrency is stopped by a fatal error.** A dead token would otherwise turn
 *     into hundreds of failures, each one an audit-log entry someone has to read.
 *
 * Group creates run one at a time. There are tens of them, not thousands, and the
 * ordering constraint (a parent must exist before its child) is easier to trust than
 * to optimise.
 */

import { matchKey, pathKey } from '../csv/path.ts';
import { regionKey } from '../csv/champions.ts';
import { PLACEHOLDER_GROUP_NAME } from '../pm/groups.ts';
import type { GroupChampions } from '../pm/champions.ts';
import type {
  ChampionPlan,
  ChampionTarget,
  PrimaryChampionAction,
  RegionalChampionAction,
} from '../plan/championPlan.ts';
import type { GroupPlan } from '../plan/groupPlan.ts';
import type { ShortcutChange, ShortcutPlan } from '../plan/shortcutPlan.ts';
import { expectedVersion } from '../plan/version.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type {
  CreateGroupResponse,
  ProcessGroupRef,
  TreeItem,
  ValidateActionResponse,
} from '../pm/types.ts';
import { Journal, step } from './journal.ts';

export interface SetShortcutsInput {
  processUniqueId: string;
  shortcuts: ProcessGroupRef[];
  changeDescription: string;
  expectedRevisionEditId: number;
  submitForApproval: boolean;
}

export interface SetShortcutsOutput {
  ok: boolean;
  revisionEditId?: number | undefined;
  conflict?: { expected: number; actual: number } | undefined;
}

/** The writes this module needs, plus the reads it uses to reconcile. */
export interface ExecGateway {
  validateGroupAction(parentUniqueId: string | null): Promise<ValidateActionResponse>;
  createGroup(parentUniqueId: string | null): Promise<CreateGroupResponse>;
  renameGroup(uniqueId: string, name: string): Promise<{ isValid: boolean }>;
  /** Reparent a group. Null parents mean the top level. */
  moveGroup(
    uniqueId: string,
    newParentUniqueId: string | null,
    oldParentUniqueId: string | null,
  ): Promise<{ success: boolean; errors: unknown[] | null }>;
  setShortcuts(input: SetShortcutsInput): Promise<SetShortcutsOutput>;
  publish(processUniqueId: string, processRevisionEditId: number): Promise<unknown>;
  /** Used only to work out whether an interrupted write actually landed. */
  processSummary(processUniqueId: string): Promise<ProcessSummary>;
  /** Reads one level of the tree — the evidence behind orphan recovery. */
  childGroups(parentUniqueId: string | null): Promise<TreeItem[]>;
  /** null removes the group's primary champion. */
  setPrimaryChampion(groupUniqueId: string, championId: number | null): Promise<unknown>;
  /** The complete regional list; an empty array removes them all. */
  setRegionalChampions(
    groupUniqueId: string,
    champions: ReadonlyArray<{ userId: number; region: string }>,
  ): Promise<unknown>;
  /** Read back after a regional write, to check the replace did what we assumed. */
  groupChampions(groupUniqueId: string): Promise<GroupChampions>;
}

/**
 * `blocked` is never produced by the runner — it is what the report calls a row the
 * planner refused before the run began. It lives in this union so refused rows and
 * attempted ones can be counted and rendered as one list.
 */
export type OutcomeResult = 'ok' | 'skipped' | 'failed' | 'blocked';

export interface Outcome {
  type: 'group' | 'process';
  /** What the operator calls it: a group path, or a process name. */
  target: string;
  targetId: string | null;
  action: string;
  result: OutcomeResult;
  before: string;
  after: string;
  detail: string;
  line: number | null;
}

export interface RunProgress {
  phase: 'groups' | 'champions' | 'shortcuts';
  done: number;
  total: number;
  label: string;
}

export interface RunInput {
  groupPlan?: GroupPlan | null | undefined;
  /**
   * Champion changes. Runs after the group plan and never without it, because an action
   * may name a group by the sequence number of a create only that plan can fulfil.
   */
  championPlan?: ChampionPlan | null | undefined;
  shortcutPlan?: ShortcutPlan | null | undefined;
}

export interface RunOptions {
  concurrency?: number | undefined;
  changeDescription?: string | undefined;
  onProgress?: ((progress: RunProgress) => void) | undefined;
  signal?: AbortSignal | undefined;
  /**
   * Whether an error should stop the whole run. Returns a reason, or null to carry on.
   * Defaults to stopping when the session has gone, since nothing after that can work.
   */
  isFatal?: ((error: unknown) => string | null) | undefined;
}

export interface RunSummary {
  outcomes: Outcome[];
  /** True when the run ended early — cancelled, or something fatal happened. */
  stopped: boolean;
  stoppedReason: string | null;
}

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_CHANGE_DESCRIPTION = 'Group shortcuts updated in bulk';

function defaultIsFatal(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'signedOut' in error) {
    if ((error as { signedOut?: boolean }).signedOut === true) {
      return 'Your session ended. Sign in again and resume — nothing after this point was attempted.';
    }
  }
  return null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runPlan(
  gateway: ExecGateway,
  journal: Journal,
  input: RunInput,
  options: RunOptions = {},
): Promise<RunSummary> {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const changeDescription = options.changeDescription ?? DEFAULT_CHANGE_DESCRIPTION;
  const isFatal = options.isFatal ?? defaultIsFatal;

  const outcomes: Outcome[] = [];
  const state = { stopped: false, reason: null as string | null };

  const stop = (reason: string): void => {
    state.stopped = true;
    state.reason = reason;
  };
  const cancelled = (): boolean => {
    if (state.stopped) return true;
    if (options.signal?.aborted === true) {
      stop('Cancelled. Anything already written stays written; nothing further was attempted.');
      return true;
    }
    return false;
  };

  const controls: Controls = {
    cancelled,
    stop,
    isFatal,
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  };

  let createdBySeq: ReadonlyMap<number, string> = new Map();
  if (input.groupPlan) {
    createdBySeq = await runGroups(gateway, journal, input.groupPlan, outcomes, controls);
  }

  if (input.championPlan && !state.stopped) {
    await runChampions(gateway, journal, input.championPlan, createdBySeq, outcomes, controls);
  }

  if (input.shortcutPlan && !state.stopped) {
    await runShortcuts(gateway, journal, input.shortcutPlan, outcomes, {
      cancelled,
      stop,
      isFatal,
      concurrency,
      changeDescription,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
  }

  return { outcomes, stopped: state.stopped, stoppedReason: state.reason };
}

interface Controls {
  cancelled(): boolean;
  stop(reason: string): void;
  isFatal(error: unknown): string | null;
  onProgress?: ((progress: RunProgress) => void) | undefined;
}

// ------------------------------------------------------- orphan recovery

/**
 * Finding a group that CreateGroup made but we never heard about.
 *
 * This is the product's known failure: create a lot of groups at once and some appear
 * to fail, then turn up named "New Group". Blindly renaming any placeholder would be
 * dangerous — it could be someone else's, or a leftover from a previous mishap — so
 * recovery is anchored to a snapshot of the parent's children taken immediately
 * *before* the create. A placeholder that was not there a moment ago, under the exact
 * parent we asked for, is ours.
 *
 * Returns null when it cannot be sure: none appeared (the create genuinely failed), or
 * more than one did (a concurrent run, and guessing would rename a stranger's group).
 */
async function findOrphan(
  gateway: ExecGateway,
  parentUniqueId: string | null,
  before: ReadonlySet<string>,
): Promise<{ uniqueId: string } | null> {
  let after: TreeItem[];
  try {
    after = await gateway.childGroups(parentUniqueId);
  } catch {
    // Without the evidence we do not guess.
    return null;
  }

  const fresh = after.filter(
    (item) =>
      !before.has(item.uniqueId) && matchKey(item.title) === matchKey(PLACEHOLDER_GROUP_NAME),
  );

  return fresh.length === 1 ? { uniqueId: (fresh[0] as TreeItem).uniqueId } : null;
}

async function snapshotChildren(
  gateway: ExecGateway,
  parentUniqueId: string | null,
): Promise<Set<string> | null> {
  try {
    return new Set((await gateway.childGroups(parentUniqueId)).map((item) => item.uniqueId));
  } catch {
    // Degraded, not fatal: the create can still go ahead, it just loses its safety net.
    return null;
  }
}

const SIBLING_SEPARATOR = ',';

export const ACTION_CREATE = 'create';
export const ACTION_RENAME = 'rename';
export const ACTION_MOVE = 'move';
/**
 * A create that only succeeded because the runner repaired something the tenant got
 * wrong. Distinct from a plain create so it can be counted and shown: it means this
 * tenant is exhibiting the half-made-group behaviour, which is worth knowing before
 * the next bulk run.
 */
export const ACTION_RECOVERED = 'create.recovered';
export const ACTION_ORPHAN = 'orphan.found';

function readSnapshot(data: Record<string, string | number | boolean | null> | null): Set<string> | null {
  const raw = data?.['siblingsBefore'];
  if (typeof raw !== 'string') return null;
  return new Set(raw === '' ? [] : raw.split(SIBLING_SEPARATOR));
}

// ---------------------------------------------------------------- groups

/**
 * Rename, create, then move — in that order, and for reasons.
 *
 * Renames go first so that a group carries the name the file gives it before anything
 * is created beside it. Creates come next, because a move may well be putting a group
 * inside a parent this same run is making. Moves come last, when both ends exist.
 */
async function runGroups(
  gateway: ExecGateway,
  journal: Journal,
  plan: GroupPlan,
  outcomes: Outcome[],
  controls: Controls,
): Promise<ReadonlyMap<number, string>> {
  const total =
    plan.renames.length + plan.creates.length + plan.moves.length;
  const progress = { done: 0, total };

  await runRenames(gateway, journal, plan, outcomes, controls, progress);
  if (controls.cancelled()) return new Map();

  // Returned even when the run stops here: the champion phase will not run, but the ids
  // of groups this run did create are what a resume needs to avoid making them twice.
  const createdBySeq = await runCreates(gateway, journal, plan, outcomes, controls, progress);
  if (controls.cancelled()) return createdBySeq;

  await runMoves(gateway, journal, plan, outcomes, controls, progress, createdBySeq);
  return createdBySeq;
}

interface GroupProgress {
  done: number;
  total: number;
}

/**
 * Rename groups that already exist.
 *
 * Distinct from the rename that finishes a create: this one acts on a group identified
 * by its id, and there is no half-made state to recover from — RenameGroup is
 * idempotent, so an interrupted attempt is safe to repeat.
 */
async function runRenames(
  gateway: ExecGateway,
  journal: Journal,
  plan: GroupPlan,
  outcomes: Outcome[],
  controls: Controls,
  progress: GroupProgress,
): Promise<void> {
  for (const rename of plan.renames) {
    if (controls.cancelled()) return;

    controls.onProgress?.({
      phase: 'groups',
      done: progress.done,
      total: progress.total,
      label: `Renaming ${rename.from}`,
    });
    progress.done++;

    const stepName = step.groupRenameById(rename.uniqueId);
    const record = (result: OutcomeResult, detail: string): void => {
      outcomes.push({
        type: 'group',
        target: rename.fromDisplay,
        targetId: rename.uniqueId,
        action: ACTION_RENAME,
        result,
        before: rename.from,
        after: result === 'ok' ? rename.to : '',
        detail,
        line: rename.line,
      });
    };

    if (journal.isCommitted(stepName)) {
      record('skipped', 'Already renamed by an earlier run in this tab.');
      continue;
    }
    // A 'begin' with no outcome is safe to repeat here — setting the same name twice
    // is harmless — so unlike a create, this needs no reconciliation.
    journal.append({
      step: stepName,
      kind: 'group.rename',
      phase: 'begin',
      data: { uniqueId: rename.uniqueId },
    });

    try {
      await gateway.renameGroup(rename.uniqueId, rename.to);
      journal.append({
        step: stepName,
        kind: 'group.rename',
        phase: 'commit',
        data: { uniqueId: rename.uniqueId, name: rename.to },
      });
      record('ok', '');
    } catch (error) {
      journal.append({ step: stepName, kind: 'group.rename', phase: 'fail' });
      const fatal = controls.isFatal(error);
      record('failed', message(error));
      if (fatal) return controls.stop(fatal);
    }
  }
}

async function runCreates(
  gateway: ExecGateway,
  journal: Journal,
  plan: GroupPlan,
  outcomes: Outcome[],
  controls: Controls,
  progress: GroupProgress,
): Promise<ReadonlyMap<number, string>> {
  const creates = [...plan.creates].sort((a, b) => a.seq - b.seq);
  /** seq -> uniqueId, so a child can be hung off a parent created moments ago. */
  const createdBySeq = new Map<number, string>();
  /** Creates that reported an error but turned out to have landed. */
  const recovered = new Set<number>();

  /** seq -> the row already reported, so the verify sweep can correct it. */
  const reported = new Map<number, Outcome>();
  /** seq -> the parent it was created under, for the verify sweep. */
  const parentBySeq = new Map<number, string | null>();

  const record = (
    create: (typeof creates)[number],
    result: OutcomeResult,
    detail: string,
    uniqueId: string | null,
    action: string = ACTION_CREATE,
  ): void => {
    const outcome: Outcome = {
      type: 'group',
      target: create.display,
      targetId: uniqueId,
      action,
      result,
      before: '',
      after: uniqueId ?? '',
      detail,
      line: create.line,
    };
    outcomes.push(outcome);
    reported.set(create.seq, outcome);
  };

  for (const create of creates) {
    if (controls.cancelled()) return createdBySeq;

    const key = pathKey(create.path);
    const createStep = step.groupCreate(key);
    const renameStep = step.groupRename(key);

    controls.onProgress?.({
      phase: 'groups',
      done: progress.done,
      total: progress.total,
      label: create.display,
    });
    progress.done++;

    // Where it hangs from. A planned parent that never got created takes its whole
    // subtree with it — creating the child at the root instead would be worse than
    // not creating it.
    let parentUniqueId: string | null = null;
    if (create.parent.kind === 'existing') {
      parentUniqueId = create.parent.uniqueId;
    } else if (create.parent.kind === 'planned') {
      const parentId = createdBySeq.get(create.parent.seq);
      if (parentId === undefined) {
        record(create, 'skipped', `Not created — its parent "${create.parent.display}" was not created.`, null);
        continue;
      }
      parentUniqueId = parentId;
    }

    let uniqueId = readCommittedId(journal, createStep);
    /** Whether this run sent anything for this group. */
    let sentSomething = false;

    if (uniqueId === null) {
      const priorPhase = journal.phaseOf(createStep);

      if (priorPhase === 'begin') {
        // An earlier attempt sent CreateGroup and never heard back. It may have landed
        // as an unnamed "New Group". The snapshot recorded at that moment is what makes
        // one identifiable as ours.
        const snapshot = readSnapshot(journal.latestData(createStep));
        const orphan =
          snapshot === null ? null : await findOrphan(gateway, parentUniqueId, snapshot);

        if (orphan === null) {
          record(
            create,
            'skipped',
            `A previous attempt may have created this group without naming it, and it ` +
              `could not be identified. Look for a group called "${PLACEHOLDER_GROUP_NAME}" ` +
              `under "${parentLabel(create)}" and either rename it to "${create.name}" or ` +
              `delete it, then run this file again.`,
            null,
          );
          continue;
        }

        uniqueId = orphan.uniqueId;
        journal.append({
          step: createStep,
          kind: 'group.create',
          phase: 'commit',
          data: { uniqueId, path: create.display, recovered: true },
        });
      } else if (priorPhase !== null) {
        record(create, 'skipped', 'Already attempted in an earlier run and not retried.', null);
        continue;
      }
    }

    if (uniqueId === null) {
      try {
        const validation = await gateway.validateGroupAction(parentUniqueId);
        if (validation.isValid === false) {
          record(create, 'failed', validation.message ?? 'Process Manager refused to create this group.', null);
          journal.append({ step: createStep, kind: 'group.create', phase: 'fail' });
          continue;
        }
        if (validation.isPrompt === true) {
          // The server wants a human asked something first. A bulk run cannot answer.
          record(
            create,
            'skipped',
            validation.message ?? 'Process Manager asked for confirmation, which a bulk run cannot give.',
            null,
          );
          journal.append({ step: createStep, kind: 'group.create', phase: 'skip' });
          continue;
        }
      } catch (error) {
        const fatal = controls.isFatal(error);
        if (fatal) {
          controls.stop(fatal);
          return createdBySeq;
        }
        record(create, 'failed', message(error), null);
        journal.append({ step: createStep, kind: 'group.create', phase: 'fail' });
        continue;
      }

      // Taken before the write, because afterwards there is no way to tell a group we
      // just made from one that was already sitting there unnamed.
      const before = await snapshotChildren(gateway, parentUniqueId);
      journal.append({
        step: createStep,
        kind: 'group.create',
        phase: 'begin',
        data: {
          path: create.display,
          parent: parentUniqueId,
          siblingsBefore: before === null ? null : [...before].join(SIBLING_SEPARATOR),
        },
      });

      try {
        const created = await gateway.createGroup(parentUniqueId);
        if (created.isValid === false || !created.groupid) {
          throw new Error('Process Manager did not return a new group.');
        }
        uniqueId = created.groupid;
        sentSomething = true;
        // Committed before the rename is attempted: this is the line that makes an
        // interrupted create a named thing rather than a mystery.
        journal.append({
          step: createStep,
          kind: 'group.create',
          phase: 'commit',
          data: { uniqueId, path: create.display },
        });
      } catch (error) {
        const fatal = controls.isFatal(error);

        // The known failure mode: CreateGroup reports an error but makes the group
        // anyway, leaving a stray "New Group". Look before believing the error.
        const orphan = before === null ? null : await findOrphan(gateway, parentUniqueId, before);

        if (orphan === null) {
          if (fatal) {
            controls.stop(fatal);
            return createdBySeq;
          }
          record(create, 'failed', message(error), null);
          journal.append({ step: createStep, kind: 'group.create', phase: 'fail' });
          continue;
        }

        uniqueId = orphan.uniqueId;
        sentSomething = true;
        journal.append({
          step: createStep,
          kind: 'group.create',
          phase: 'commit',
          data: { uniqueId, path: create.display, recovered: true },
        });
        recovered.add(create.seq);
      }
    }

    if (!journal.isCommitted(renameStep)) {
      journal.append({ step: renameStep, kind: 'group.rename', phase: 'begin', data: { uniqueId } });
      try {
        await gateway.renameGroup(uniqueId, create.name);
        sentSomething = true;
        journal.append({
          step: renameStep,
          kind: 'group.rename',
          phase: 'commit',
          data: { uniqueId, name: create.name },
        });
      } catch (error) {
        journal.append({ step: renameStep, kind: 'group.rename', phase: 'fail', data: { uniqueId } });
        const fatal = controls.isFatal(error);
        // The group exists but still carries the placeholder name. Its children can
        // still be created in the right place, so the id is registered either way —
        // but this must be shouted about, because a later re-run of the same file
        // will not recognise it and will create a second group.
        createdBySeq.set(create.seq, uniqueId);
        record(
          create,
          'failed',
          `Created, but naming it failed (${message(error)}). There is now a group called ` +
            `"New Group" under "${parentLabel(create)}". Rename it to "${create.name}" in ` +
            `Process Manager before running this file again.`,
          uniqueId,
        );
        if (fatal) {
          controls.stop(fatal);
          return createdBySeq;
        }
        continue;
      }
    }

    createdBySeq.set(create.seq, uniqueId);
    parentBySeq.set(create.seq, parentUniqueId);
    // A group carried over from an earlier run is not work this run did, and a report
    // that says otherwise cannot be trusted as an audit log.
    if (recovered.has(create.seq)) {
      record(
        create,
        'ok',
        'Process Manager reported an error creating this group, but it had in fact been ' +
          'created. Recovered and named it rather than making a second one.',
        uniqueId,
        ACTION_RECOVERED,
      );
    } else if (sentSomething) {
      record(create, 'ok', '', uniqueId);
    } else {
      record(create, 'skipped', 'Already created by an earlier run in this tab.', uniqueId);
    }
  }

  if (!controls.cancelled()) {
    await verifyNames(gateway, journal, {
      creates,
      createdBySeq,
      parentBySeq,
      reported,
      outcomes,
      controls,
    });
  }

  return createdBySeq;
}

/**
 * Reparent groups that already exist.
 *
 * Runs last, so a destination this file also creates is there by the time we get here.
 * A move is a single call that either happened or did not — there is no half-moved
 * state to recover from — but it is *not* idempotent in a useful sense: repeating one
 * whose outcome we never learned could reparent a group someone has since moved back.
 * So an interrupted move is reported rather than retried.
 */
async function runMoves(
  gateway: ExecGateway,
  journal: Journal,
  plan: GroupPlan,
  outcomes: Outcome[],
  controls: Controls,
  progress: GroupProgress,
  createdBySeq: ReadonlyMap<number, string>,
): Promise<void> {
  for (const move of plan.moves) {
    if (controls.cancelled()) return;

    controls.onProgress?.({
      phase: 'groups',
      done: progress.done,
      total: progress.total,
      label: `Moving ${move.name}`,
    });
    progress.done++;

    const stepName = step.groupMove(move.uniqueId);
    const record = (result: OutcomeResult, detail: string): void => {
      outcomes.push({
        type: 'group',
        target: move.fromDisplay,
        targetId: move.uniqueId,
        action: ACTION_MOVE,
        result,
        before: move.fromDisplay,
        after: result === 'ok' ? move.toDisplay : '',
        detail,
        line: move.line,
      });
    };

    if (journal.isCommitted(stepName)) {
      record('skipped', 'Already moved by an earlier run in this tab.');
      continue;
    }
    if (journal.phaseOf(stepName) === 'begin') {
      record(
        'failed',
        `An earlier attempt sent this move and never heard back, so it is not certain ` +
          `whether it happened. Check where "${move.name}" sits in Process Manager ` +
          `before running this file again.`,
      );
      continue;
    }
    if (journal.isSettled(stepName)) {
      record('skipped', 'Already attempted in an earlier run and not retried.');
      continue;
    }

    // Where it lands. A destination this run was supposed to create but did not takes
    // the move with it — moving the group to the top level instead would scatter the
    // tree rather than restructure it.
    let newParentUniqueId: string | null = null;
    if (move.toParent.kind === 'existing') {
      newParentUniqueId = move.toParent.uniqueId;
    } else if (move.toParent.kind === 'planned') {
      const created = createdBySeq.get(move.toParent.seq);
      if (created === undefined) {
        record('skipped', `Not moved — its new parent "${move.toParent.display}" was not created.`);
        continue;
      }
      newParentUniqueId = created;
    }

    journal.append({
      step: stepName,
      kind: 'group.move',
      phase: 'begin',
      data: { uniqueId: move.uniqueId, to: newParentUniqueId, from: move.fromParentUniqueId },
    });

    try {
      const result = await gateway.moveGroup(
        move.uniqueId,
        newParentUniqueId,
        move.fromParentUniqueId,
      );
      if (result.success !== true) {
        // The endpoint answers `{success, errors}` rather than an HTTP status, so a
        // refusal arrives as a perfectly good 200.
        throw new Error(
          describeReorderErrors(result.errors) ?? 'Process Manager refused the move.',
        );
      }

      journal.append({
        step: stepName,
        kind: 'group.move',
        phase: 'commit',
        data: { uniqueId: move.uniqueId, to: newParentUniqueId },
      });
      record('ok', '');
    } catch (error) {
      journal.append({ step: stepName, kind: 'group.move', phase: 'fail' });
      const fatal = controls.isFatal(error);
      record('failed', message(error));
      if (fatal) return controls.stop(fatal);
    }
  }

  controls.onProgress?.({
    phase: 'groups',
    done: progress.total,
    total: progress.total,
    label: '',
  });
}

/** Whatever the server put in `errors`, rendered for someone to read. */
function describeReorderErrors(errors: unknown[] | null): string | null {
  if (!errors || errors.length === 0) return null;
  return errors
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
    .join('; ');
}

interface VerifyContext {
  creates: readonly GroupPlan['creates'][number][];
  createdBySeq: ReadonlyMap<number, string>;
  parentBySeq: ReadonlyMap<number, string | null>;
  reported: ReadonlyMap<number, Outcome>;
  outcomes: Outcome[];
  controls: Controls;
}

/**
 * Confirm every group this run created actually carries the name it was given.
 *
 * RenameGroup can report success without the name sticking, and a group left as
 * "New Group" is invisible to a later re-run — which will happily create a second one.
 * One read per distinct parent, not per group, so this costs a handful of requests
 * however large the file is.
 *
 * It also reports unnamed groups it did *not* create, because a tenant that already
 * has some is the situation that produces duplicates in the first place.
 */
function stillUnnamed(actualTitle: string, wanted: string, why: string): string {
  return (
    `Created, but it is still called "${actualTitle}" — naming it did not take (${why}). ` +
    `Rename it to "${wanted}" in Process Manager before running this file again, or the ` +
    `next run will not recognise it and will create a second copy.`
  );
}

async function verifyNames(
  gateway: ExecGateway,
  journal: Journal,
  ctx: VerifyContext,
): Promise<void> {
  const byParent = new Map<string, { parent: string | null; seqs: number[] }>();
  for (const create of ctx.creates) {
    if (!ctx.createdBySeq.has(create.seq)) continue;
    const parent = ctx.parentBySeq.get(create.seq) ?? null;
    const key = parent ?? '\u0000root';
    const entry = byParent.get(key) ?? { parent, seqs: [] };
    entry.seqs.push(create.seq);
    byParent.set(key, entry);
  }

  for (const { parent, seqs } of byParent.values()) {
    let items: TreeItem[];
    try {
      items = await gateway.childGroups(parent);
    } catch {
      // Verification is a safety net, not a gate. Failing to read must not turn a
      // successful run into a reported failure.
      continue;
    }

    const byUniqueId = new Map(items.map((item) => [item.uniqueId, item]));
    const ours = new Set<string>();
    /** Groups whose name did not take, and which got one more attempt. */
    const retried: number[] = [];

    for (const seq of seqs) {
      const uniqueId = ctx.createdBySeq.get(seq) as string;
      ours.add(uniqueId);

      const create = ctx.creates.find((c) => c.seq === seq);
      const outcome = ctx.reported.get(seq);
      if (!create || !outcome) continue;

      const actual = byUniqueId.get(uniqueId);
      if (!actual) {
        // Not in the listing. That is not evidence of a problem — the read may be
        // partial, or filtered by permission — and a run report that invents failures
        // is worse than one that stays quiet. Only a name we can *see* is wrong counts.
        continue;
      }
      if (matchKey(actual.title) === matchKey(create.name)) {
        // Named correctly. If the rename had reported an error, it evidently took.
        if (outcome.result === 'failed' && /naming it failed/.test(outcome.detail)) {
          outcome.result = 'ok';
          outcome.detail = 'Naming reported an error but did take effect.';
        }
        continue;
      }

      // Still unnamed. One more attempt, because rename is idempotent and this is the
      // difference between a tidy tree and an orphan nobody can identify later.
      try {
        await gateway.renameGroup(uniqueId, create.name);
        retried.push(seq);
      } catch (error) {
        outcome.result = 'failed';
        outcome.detail = stillUnnamed(actual.title, create.name, message(error));
      }
    }

    if (retried.length > 0) {
      // Re-read rather than trusting the retry's response. The whole reason we are here
      // is that RenameGroup can report success without the name taking.
      let after: TreeItem[];
      try {
        after = await gateway.childGroups(parent);
      } catch {
        after = [];
      }
      const titles = new Map(after.map((entry) => [entry.uniqueId, entry.title]));

      for (const seq of retried) {
        const uniqueId = ctx.createdBySeq.get(seq) as string;
        const create = ctx.creates.find((c) => c.seq === seq);
        const outcome = ctx.reported.get(seq);
        if (!create || !outcome) continue;

        const title = titles.get(uniqueId);
        if (title !== undefined && matchKey(title) === matchKey(create.name)) {
          journal.append({
            step: step.groupRename(pathKey(create.path)),
            kind: 'group.rename',
            phase: 'commit',
            data: { uniqueId, name: create.name, secondAttempt: true },
          });
          outcome.result = 'ok';
          // A group can hit both faults — the create lies, then the rename does too.
          // Replacing the detail would throw away half the evidence.
          outcome.detail =
            outcome.action === ACTION_RECOVERED
              ? `${outcome.detail} Naming it then reported success without taking effect, ` +
                `and needed a second attempt.`
              : 'Process Manager reported this group renamed when it had not been. Named ' +
                'it on a second attempt.';
          outcome.action = ACTION_RECOVERED;
          continue;
        }

        outcome.result = 'failed';
        outcome.detail = stillUnnamed(title ?? PLACEHOLDER_GROUP_NAME, create.name, 'twice');
        // The group is now genuinely an orphan, so stop calling it ours.
        ours.delete(uniqueId);
      }

      if (after.length > 0) items = after;
    }

    for (const item of items) {
      if (ours.has(item.uniqueId)) continue;
      if (matchKey(item.title) !== matchKey(PLACEHOLDER_GROUP_NAME)) continue;
      ctx.outcomes.push({
        type: 'group',
        target: item.title,
        targetId: item.uniqueId,
        action: ACTION_ORPHAN,
        result: 'skipped',
        before: '',
        after: '',
        detail:
          `An unnamed group is sitting under "${parent === null ? 'the top level' : parent}". ` +
          `This run did not create it — it is left over from an earlier interrupted ` +
          `attempt, here or in Process Manager itself. Rename or delete it.`,
        line: null,
      });
    }
  }
}

function parentLabel(create: GroupPlan['creates'][number]): string {
  return create.parent.kind === 'root' ? 'the top level' : create.parent.display;
}

function readCommittedId(journal: Journal, stepName: string): string | null {
  const data = journal.commitData(stepName);
  const uniqueId = data?.['uniqueId'];
  return typeof uniqueId === 'string' && uniqueId !== '' ? uniqueId : null;
}

// ------------------------------------------------------------- champions

export const ACTION_CHAMPION = 'champion.assign';
export const ACTION_CHAMPION_REMOVE = 'champion.remove';
export const ACTION_CHAMPION_REGIONAL = 'champion.regional';

/**
 * Resolve an action's group to a real id.
 *
 * A champion can be set on a group this same run creates, in which case the plan names
 * the create's sequence number and the id only exists once that create has succeeded.
 * Null means it did not, and the champion is skipped rather than applied to nothing.
 */
function targetId(
  target: ChampionTarget,
  createdBySeq: ReadonlyMap<number, string>,
): string | null {
  return target.kind === 'existing' ? target.uniqueId : createdBySeq.get(target.seq) ?? null;
}

function describePeople(people: RegionalChampionAction['people']): string {
  return people.map((p) => `${p.region}: ${p.displayName}`).join('; ');
}

/**
 * Apply the champion changes.
 *
 * Both writes set state rather than adding to it, so both are safe to repeat — which is
 * why an interrupted one is retried here rather than reported as unknown the way a move
 * is. What is *not* assumed is that the regional endpoint replaces rather than merges:
 * every regional write is read back and any difference is reported.
 *
 * Serial, like the group creates: there are tens of these, not thousands, and each one
 * grants somebody the ability to restructure a branch.
 */
async function runChampions(
  gateway: ExecGateway,
  journal: Journal,
  plan: ChampionPlan,
  createdBySeq: ReadonlyMap<number, string>,
  outcomes: Outcome[],
  controls: Controls,
): Promise<void> {
  const total = plan.primary.length + plan.regional.length;
  const progress = { done: 0, total };

  for (const action of plan.primary) {
    if (controls.cancelled()) return;
    await runPrimaryChampion(gateway, journal, action, createdBySeq, outcomes, controls, progress);
  }

  for (const action of plan.regional) {
    if (controls.cancelled()) return;
    await runRegionalChampions(gateway, journal, action, createdBySeq, outcomes, controls, progress);
  }
}

async function runPrimaryChampion(
  gateway: ExecGateway,
  journal: Journal,
  action: PrimaryChampionAction,
  createdBySeq: ReadonlyMap<number, string>,
  outcomes: Outcome[],
  controls: Controls,
  progress: GroupProgress,
): Promise<void> {
  const wanted = action.person;
  const after = wanted === null ? 'nobody' : `${wanted.displayName} (${wanted.logon})`;

  controls.onProgress?.({
    phase: 'champions',
    done: progress.done,
    total: progress.total,
    label: `${action.display}: ${after}`,
  });
  progress.done++;

  const record = (result: OutcomeResult, detail: string, uniqueId: string | null): void => {
    outcomes.push({
      type: 'group',
      target: action.display,
      targetId: uniqueId,
      action: wanted === null ? ACTION_CHAMPION_REMOVE : ACTION_CHAMPION,
      result,
      before: action.before ?? '',
      after: result === 'ok' ? after : '',
      detail,
      line: action.line,
    });
  };

  const stepName = step.championPrimary(action.key);
  if (journal.isCommitted(stepName)) {
    record('skipped', 'Already set by an earlier run in this tab.', targetId(action.target, createdBySeq));
    return;
  }

  const uniqueId = targetId(action.target, createdBySeq);
  if (uniqueId === null) {
    record('skipped', `The group was not created, so it has no champion to set.`, null);
    return;
  }

  journal.append({
    step: stepName,
    kind: 'group.champion',
    phase: 'begin',
    data: { uniqueId, championId: wanted?.userId ?? null },
  });

  try {
    await gateway.setPrimaryChampion(uniqueId, wanted?.userId ?? null);
    journal.append({
      step: stepName,
      kind: 'group.champion',
      phase: 'commit',
      data: { uniqueId, championId: wanted?.userId ?? null },
    });
    record('ok', '', uniqueId);
  } catch (error) {
    journal.append({ step: stepName, kind: 'group.champion', phase: 'fail' });
    const fatal = controls.isFatal(error);
    record('failed', message(error), uniqueId);
    if (fatal) controls.stop(fatal);
  }
}

async function runRegionalChampions(
  gateway: ExecGateway,
  journal: Journal,
  action: RegionalChampionAction,
  createdBySeq: ReadonlyMap<number, string>,
  outcomes: Outcome[],
  controls: Controls,
  progress: GroupProgress,
): Promise<void> {
  const after = action.people.length === 0 ? 'nobody' : describePeople(action.people);

  controls.onProgress?.({
    phase: 'champions',
    done: progress.done,
    total: progress.total,
    label: `${action.display}: regional champions`,
  });
  progress.done++;

  const record = (result: OutcomeResult, detail: string, uniqueId: string | null): void => {
    outcomes.push({
      type: 'group',
      target: action.display,
      targetId: uniqueId,
      action: ACTION_CHAMPION_REGIONAL,
      result,
      before: action.before.map((entry) => `${entry.region}: ${entry.name}`).join('; '),
      after: result === 'ok' ? after : '',
      detail,
      line: action.line,
    });
  };

  const stepName = step.championRegional(action.key);
  if (journal.isCommitted(stepName)) {
    record('skipped', 'Already set by an earlier run in this tab.', targetId(action.target, createdBySeq));
    return;
  }

  const uniqueId = targetId(action.target, createdBySeq);
  if (uniqueId === null) {
    record('skipped', 'The group was not created, so it has no champions to set.', null);
    return;
  }

  const payload = action.people.map((person) => ({ userId: person.userId, region: person.region }));

  journal.append({
    step: stepName,
    kind: 'group.regionalChampions',
    phase: 'begin',
    data: { uniqueId, count: payload.length },
  });

  try {
    await gateway.setRegionalChampions(uniqueId, payload);
  } catch (error) {
    journal.append({ step: stepName, kind: 'group.regionalChampions', phase: 'fail' });
    const fatal = controls.isFatal(error);
    record('failed', message(error), uniqueId);
    if (fatal) controls.stop(fatal);
    return;
  }

  journal.append({
    step: stepName,
    kind: 'group.regionalChampions',
    phase: 'commit',
    data: { uniqueId, count: payload.length },
  });

  record('ok', await verifyRegional(gateway, uniqueId, payload), uniqueId);
}

/**
 * Read the regional champions back.
 *
 * The write is documented nowhere: the admin screen sends the whole array, so we take it
 * to replace what is there — but "we assume it replaces" is not something to leave in a
 * report about who can administer a branch. A mismatch is reported as detail on a step
 * that did happen, not as a failure, because the write itself succeeded.
 */
async function verifyRegional(
  gateway: ExecGateway,
  uniqueId: string,
  wanted: ReadonlyArray<{ userId: number; region: string }>,
): Promise<string> {
  let actual: GroupChampions;
  try {
    actual = await gateway.groupChampions(uniqueId);
  } catch {
    // Verification is a safety net, not a gate.
    return '';
  }

  const key = (entry: { userId: number; region: string }): string =>
    `${entry.userId}@${regionKey(entry.region)}`;
  const wantedKeys = new Set(wanted.map(key));
  const actualKeys = new Set(actual.regional.map(key));

  const missing = wanted.filter((entry) => !actualKeys.has(key(entry)));
  const extra = actual.regional.filter((entry) => !wantedKeys.has(key(entry)));

  if (missing.length === 0 && extra.length === 0) return '';

  const parts: string[] = [];
  if (missing.length > 0) {
    parts.push(`${missing.length} of them did not take`);
  }
  if (extra.length > 0) {
    // The interesting case: the endpoint added to the list instead of replacing it, so
    // people the file left out are still regional champions of this group.
    parts.push(
      `${extra.map((e) => `${e.region}: ${e.name}`).join('; ')} ${
        extra.length === 1 ? 'is' : 'are'
      } still set, which this file did not list`,
    );
  }

  return `Read back afterwards and ${parts.join(', and ')}. Check this group in Process Manager.`;
}

// ------------------------------------------------------------- shortcuts

interface ShortcutControls extends Controls {
  concurrency: number;
  changeDescription: string;
}

async function runShortcuts(
  gateway: ExecGateway,
  journal: Journal,
  plan: ShortcutPlan,
  outcomes: Outcome[],
  controls: ShortcutControls,
): Promise<void> {
  const changes = [...plan.updates, ...plan.clears].sort((a, b) => a.line - b.line);
  let done = 0;

  for (let i = 0; i < changes.length; i += controls.concurrency) {
    if (controls.cancelled()) break;

    const batch = changes.slice(i, i + controls.concurrency);
    const results = await Promise.all(
      batch.map((change) => applyShortcuts(gateway, journal, change, controls)),
    );

    for (const result of results) outcomes.push(result);
    done += batch.length;
    controls.onProgress?.({
      phase: 'shortcuts',
      done: Math.min(done, changes.length),
      total: changes.length,
      label: batch[batch.length - 1]?.processName ?? '',
    });
  }
}

const CARRIED_OVER =
  'Already completed by an earlier run in this tab. Nothing was sent, and the process ' +
  'already has these shortcuts.';

function outcomeFor(change: ShortcutChange, result: OutcomeResult, detail: string): Outcome {
  return {
    type: 'process',
    target: change.processName,
    targetId: change.processUniqueId,
    action: change.desired.length === 0 ? 'shortcuts.clear' : 'shortcuts.update',
    result,
    before: change.version,
    // Expected, not observed: the write returns a revision id, never a version string.
    // Only claimed for a write that actually succeeded.
    after: result === 'ok' ? (expectedVersion(change.version, change.writePath) ?? '') : '',
    detail,
    line: change.line,
  };
}

/** Group references for the write payload. */
function toGroupRefs(change: ShortcutChange): ProcessGroupRef[] {
  return change.desired.map((group) => ({
    Id: group.id,
    UniqueId: group.uniqueId,
    Name: group.name,
  }));
}

async function applyShortcuts(
  gateway: ExecGateway,
  journal: Journal,
  change: ShortcutChange,
  controls: ShortcutControls,
): Promise<Outcome> {
  const writeStep = step.shortcuts(change.processUniqueId);
  const publishStep = step.publish(change.processUniqueId);
  const needsPublish = change.writePath.kind !== 'save-only';

  const shortcuts = toGroupRefs(change);

  let revisionEditId: number | null = null;
  /** Whether this run sent anything, as opposed to inheriting an earlier one's work. */
  let wroteHere = false;

  if (journal.isCommitted(writeStep)) {
    const committed = journal.commitData(writeStep)?.['revisionEditId'];
    revisionEditId = typeof committed === 'number' ? committed : null;
  } else if (journal.isSettled(writeStep)) {
    return outcomeFor(change, 'skipped', 'Already attempted in an earlier run and not retried.');
  } else {
    if (journal.phaseOf(writeStep) === 'begin') {
      // Interrupted mid-write. Ask the tenant what actually happened rather than
      // guessing: writing again would stack a second version onto the first.
      const reconciled = await reconcile(gateway, change, shortcuts, controls);
      if (reconciled.kind === 'stop') return reconciled.outcome;
      if (reconciled.kind === 'landed') {
        revisionEditId = reconciled.revisionEditId;
        journal.append({
          step: writeStep,
          kind: 'shortcuts.write',
          phase: 'commit',
          data: { revisionEditId, reconciled: true },
        });
      }
      // 'retry' falls through to the normal write below.
    }

    if (revisionEditId === null) {
      journal.append({ step: writeStep, kind: 'shortcuts.write', phase: 'begin' });
      try {
        const result = await gateway.setShortcuts({
          processUniqueId: change.processUniqueId,
          shortcuts,
          changeDescription: controls.changeDescription,
          expectedRevisionEditId: change.revisionEditId,
          submitForApproval: change.writePath.kind === 'submit-then-publish',
        });

        if (result.conflict) {
          // Someone edited this process between the preview and now. Writing would
          // discard their change silently.
          journal.append({ step: writeStep, kind: 'shortcuts.write', phase: 'skip' });
          return outcomeFor(
            change,
            'skipped',
            'Changed by someone else since the preview was taken. Re-upload to pick up their edit.',
          );
        }
        if (!result.ok || typeof result.revisionEditId !== 'number') {
          throw new Error('Process Manager did not confirm the save.');
        }

        revisionEditId = result.revisionEditId;
        wroteHere = true;
        journal.append({
          step: writeStep,
          kind: 'shortcuts.write',
          phase: 'commit',
          data: { revisionEditId },
        });
      } catch (error) {
        journal.append({ step: writeStep, kind: 'shortcuts.write', phase: 'fail' });
        const fatal = controls.isFatal(error);
        if (fatal) controls.stop(fatal);
        return outcomeFor(change, 'failed', message(error));
      }
    }
  }

  if (!needsPublish) {
    return wroteHere
      ? outcomeFor(
          change,
          'ok',
          change.fromPublished
            ? 'Saved as a draft. The published version still has its old shortcuts.'
            : 'Saved as a draft. Not published.',
        )
      : outcomeFor(change, 'skipped', CARRIED_OVER);
  }

  if (journal.isCommitted(publishStep)) {
    // Both halves came from an earlier run. The tenant is in the right state, but this
    // run sent nothing, and a report that claims otherwise is worse than useless.
    return wroteHere
      ? outcomeFor(change, 'ok', 'Published.')
      : outcomeFor(change, 'skipped', CARRIED_OVER);
  }
  if (journal.phaseOf(publishStep) === 'begin') {
    // A repeated publish would burn a second major version on a process that may
    // already be correct. Report it and let a human look.
    return outcomeFor(
      change,
      'failed',
      'Saved, but it is not certain the publish completed. Check this process in Process Manager.',
    );
  }
  if (revisionEditId === null) {
    return outcomeFor(
      change,
      'failed',
      'Saved, but the new revision id was not returned, so it was not published.',
    );
  }

  journal.append({ step: publishStep, kind: 'process.publish', phase: 'begin', data: { revisionEditId } });
  try {
    await gateway.publish(change.processUniqueId, revisionEditId);
    journal.append({ step: publishStep, kind: 'process.publish', phase: 'commit' });
    return outcomeFor(change, 'ok', 'Published.');
  } catch (error) {
    journal.append({ step: publishStep, kind: 'process.publish', phase: 'fail' });
    const fatal = controls.isFatal(error);
    if (fatal) controls.stop(fatal);
    return outcomeFor(
      change,
      'failed',
      `Saved, but publishing failed (${message(error)}). The change is in the process but not published.`,
    );
  }
}

type Reconciliation =
  | { kind: 'landed'; revisionEditId: number }
  | { kind: 'retry' }
  | { kind: 'stop'; outcome: Outcome };

/** Work out whether an interrupted write actually reached the tenant. */
async function reconcile(
  gateway: ExecGateway,
  change: ShortcutChange,
  desired: readonly ProcessGroupRef[],
  controls: ShortcutControls,
): Promise<Reconciliation> {
  let summary: ProcessSummary;
  try {
    summary = await gateway.processSummary(change.processUniqueId);
  } catch (error) {
    const fatal = controls.isFatal(error);
    if (fatal) controls.stop(fatal);
    return {
      kind: 'stop',
      outcome: outcomeFor(
        change,
        'failed',
        `An earlier attempt was interrupted and this process could not be re-read ` +
          `(${message(error)}). Check it in Process Manager.`,
      ),
    };
  }

  const current = new Set(summary.currentShortcuts.map((s) => s.UniqueId));
  const matches =
    current.size === desired.length && desired.every((ref) => current.has(ref.UniqueId));

  // The shortcuts are already what the file asks for, so the interrupted write landed.
  if (matches) return { kind: 'landed', revisionEditId: summary.revisionEditId };

  // It did not land. The revision moved on anyway if someone else edited it, and the
  // server-side check will catch that when we write.
  return { kind: 'retry' };
}
