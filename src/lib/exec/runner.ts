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
import { PLACEHOLDER_GROUP_NAME } from '../pm/groups.ts';
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
  setShortcuts(input: SetShortcutsInput): Promise<SetShortcutsOutput>;
  publish(processUniqueId: string, processRevisionEditId: number): Promise<unknown>;
  /** Used only to work out whether an interrupted write actually landed. */
  processSummary(processUniqueId: string): Promise<ProcessSummary>;
  /** Reads one level of the tree — the evidence behind orphan recovery. */
  childGroups(parentUniqueId: string | null): Promise<TreeItem[]>;
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
  /** Creates that reported an error but turned out to have landed. */
  const recovered = new Set<number>();
  let done = 0;

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
        if (fatal) return controls.stop(fatal);
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
          if (fatal) return controls.stop(fatal);
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
        if (fatal) return controls.stop(fatal);
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

  controls.onProgress?.({
    phase: 'groups',
    done: creates.length,
    total: creates.length,
    label: '',
  });

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
    const key = parent ?? ' root';
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
