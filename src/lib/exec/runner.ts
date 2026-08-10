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

import { pathKey } from '../csv/path.ts';
import type { GroupPlan } from '../plan/groupPlan.ts';
import type { ShortcutChange, ShortcutPlan } from '../plan/shortcutPlan.ts';
import { expectedVersion } from '../plan/version.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type {
  CreateGroupResponse,
  ProcessGroupRef,
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

/** The writes this module needs, plus the one read it uses to reconcile. */
export interface ExecGateway {
  validateGroupAction(parentUniqueId: string | null): Promise<ValidateActionResponse>;
  createGroup(parentUniqueId: string | null): Promise<CreateGroupResponse>;
  renameGroup(uniqueId: string, name: string): Promise<{ isValid: boolean }>;
  setShortcuts(input: SetShortcutsInput): Promise<SetShortcutsOutput>;
  publish(processUniqueId: string, processRevisionEditId: number): Promise<unknown>;
  /** Used only to work out whether an interrupted write actually landed. */
  processSummary(processUniqueId: string): Promise<ProcessSummary>;
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
  phase: 'groups' | 'shortcuts';
  done: number;
  total: number;
  label: string;
}

export interface RunInput {
  groupPlan?: GroupPlan | null | undefined;
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

  if (input.groupPlan) {
    await runGroups(gateway, journal, input.groupPlan, outcomes, {
      cancelled,
      stop,
      isFatal,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
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

// ---------------------------------------------------------------- groups

async function runGroups(
  gateway: ExecGateway,
  journal: Journal,
  plan: GroupPlan,
  outcomes: Outcome[],
  controls: Controls,
): Promise<void> {
  const creates = [...plan.creates].sort((a, b) => a.seq - b.seq);
  /** seq -> uniqueId, so a child can be hung off a parent created moments ago. */
  const createdBySeq = new Map<number, string>();
  let done = 0;

  const record = (
    create: (typeof creates)[number],
    result: OutcomeResult,
    detail: string,
    uniqueId: string | null,
  ): void => {
    outcomes.push({
      type: 'group',
      target: create.display,
      targetId: uniqueId,
      action: 'create',
      result,
      before: '',
      after: uniqueId ?? '',
      detail,
      line: create.line,
    });
  };

  for (const create of creates) {
    if (controls.cancelled()) return;

    const key = pathKey(create.path);
    const createStep = step.groupCreate(key);
    const renameStep = step.groupRename(key);

    controls.onProgress?.({
      phase: 'groups',
      done,
      total: creates.length,
      label: create.display,
    });
    done++;

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
        // The tab died between sending CreateGroup and hearing back, so a group named
        // "New Group" may or may not exist under this parent. Creating another would
        // leave two indistinguishable orphans; adopting one risks renaming a group
        // somebody else made. Neither is ours to guess at.
        record(
          create,
          'skipped',
          `A previous run may have created this group without naming it. Look for a group ` +
            `called "New Group" under "${parentLabel(create)}" and either rename it to ` +
            `"${create.name}" or delete it, then run this file again.`,
          null,
        );
        continue;
      }

      if (priorPhase !== null) {
        record(create, 'skipped', 'Already attempted in an earlier run and not retried.', null);
        continue;
      }

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
        if (fatal) return controls.stop(fatal);
        record(create, 'failed', message(error), null);
        journal.append({ step: createStep, kind: 'group.create', phase: 'fail' });
        continue;
      }

      journal.append({
        step: createStep,
        kind: 'group.create',
        phase: 'begin',
        data: { path: create.display, parent: parentUniqueId },
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
        if (fatal) return controls.stop(fatal);
        record(create, 'failed', message(error), null);
        journal.append({ step: createStep, kind: 'group.create', phase: 'fail' });
        continue;
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
        if (fatal) return controls.stop(fatal);
        continue;
      }
    }

    createdBySeq.set(create.seq, uniqueId);
    // A group carried over from an earlier run is not work this run did, and a report
    // that says otherwise cannot be trusted as an audit log.
    if (sentSomething) record(create, 'ok', '', uniqueId);
    else record(create, 'skipped', 'Already created by an earlier run in this tab.', uniqueId);
  }

  controls.onProgress?.({
    phase: 'groups',
    done: creates.length,
    total: creates.length,
    label: '',
  });
}

function parentLabel(create: GroupPlan['creates'][number]): string {
  return create.parent.kind === 'root' ? 'the top level' : create.parent.display;
}

function readCommittedId(journal: Journal, stepName: string): string | null {
  const data = journal.commitData(stepName);
  const uniqueId = data?.['uniqueId'];
  return typeof uniqueId === 'string' && uniqueId !== '' ? uniqueId : null;
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

/** Group references for the write payload, or null when one cannot be built. */
function toGroupRefs(change: ShortcutChange): ProcessGroupRef[] | null {
  const refs: ProcessGroupRef[] = [];
  for (const group of change.desired) {
    if (group.uniqueId === null || group.id === null) return null;
    refs.push({ Id: group.id, UniqueId: group.uniqueId, Name: group.name });
  }
  return refs;
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
  if (shortcuts === null) {
    return outcomeFor(
      change,
      'skipped',
      'Points at a group this run is creating. Apply the group file first, then this one.',
    );
  }

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
      ? outcomeFor(change, 'ok', 'Saved as a draft. Not published.')
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
