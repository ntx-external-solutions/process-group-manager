import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { CreateAction, GroupPlan } from '../plan/groupPlan.ts';
import type { ResolvedGroup, ShortcutChange, ShortcutPlan } from '../plan/shortcutPlan.ts';
import type { ProcessSummary } from '../pm/operations.ts';
import type { TreeItem } from '../pm/types.ts';
import { Journal, step } from './journal.ts';
import { runPlan, type ExecGateway, type Outcome, type SetShortcutsInput } from './runner.ts';

const PROCESS = '6a9779c8-70b8-45d8-bb36-9de47b9fbf7c';

function journal(): Journal {
  return Journal.start('run-1', 'demo', 1_000, null);
}

interface Call {
  op: string;
  args: unknown;
}

interface Harness {
  gateway: ExecGateway;
  calls: Call[];
  ops(): string[];
  /** Ops that change something. Tree reads are a safety net, not part of the sequence. */
  writes(): string[];
}

interface Overrides {
  validateGroupAction?: ExecGateway['validateGroupAction'];
  createGroup?: ExecGateway['createGroup'];
  renameGroup?: ExecGateway['renameGroup'];
  moveGroup?: ExecGateway['moveGroup'];
  setShortcuts?: ExecGateway['setShortcuts'];
  publish?: ExecGateway['publish'];
  processSummary?: ExecGateway['processSummary'];
  childGroups?: ExecGateway['childGroups'];
}

let treeItemId = 500;

/** A group as the tree endpoint reports it. */
function item(uniqueId: string, title: string): TreeItem {
  return {
    id: treeItemId++,
    uniqueId,
    title,
    itemType: 'group',
    itemOrder: 0,
    hasChild: false,
    totalSubgroups: null,
    totalStakeholderUsers: null,
    totalPermissionRoles: null,
    totalPermissionUsers: null,
    variationSetId: null,
  };
}

/**
 * A tenant whose group tree actually changes when you write to it — the only way to
 * exercise orphan recovery, which is entirely about comparing before and after.
 */
function liveTree() {
  const children = new Map<string, Map<string, string>>();
  const key = (parent: string | null) => parent ?? ' root';

  return {
    childrenOf: (parent: string | null): TreeItem[] =>
      [...(children.get(key(parent)) ?? new Map()).entries()].map(([u, t]) => item(u, t)),
    add: (parent: string | null, uniqueId: string, title: string) => {
      const map = children.get(key(parent)) ?? new Map<string, string>();
      map.set(uniqueId, title);
      children.set(key(parent), map);
    },
    rename: (parent: string | null, uniqueId: string, title: string) => {
      children.get(key(parent))?.set(uniqueId, title);
    },
    titleOf: (parent: string | null, uniqueId: string) => children.get(key(parent))?.get(uniqueId),
  };
}

function harness(over: Overrides = {}): Harness {
  const calls: Call[] = [];
  /** Per-harness, so ids do not drift between tests. */
  let created = 0;

  const gateway: ExecGateway = {
    validateGroupAction: async (parent) => {
      calls.push({ op: 'validate', args: parent });
      return over.validateGroupAction
        ? over.validateGroupAction(parent)
        : {
            isValid: true,
            isCancelled: false,
            isPrompt: false,
            title: null,
            message: null,
            continueLabel: null,
            cancelLabel: null,
            additionalInfos: null,
            errorCode: null,
          };
    },
    createGroup: async (parent) => {
      calls.push({ op: 'create', args: parent });
      if (over.createGroup) return over.createGroup(parent);
      created++;
      return { isValid: true, parentGroupId: parent, groupid: `new-${created}`, groupName: 'New Group' };
    },
    renameGroup: async (uniqueId, name) => {
      calls.push({ op: 'rename', args: { uniqueId, name } });
      return over.renameGroup ? over.renameGroup(uniqueId, name) : { isValid: true };
    },
    moveGroup: async (uniqueId, newParent, oldParent) => {
      calls.push({ op: 'move', args: { uniqueId, newParent, oldParent } });
      return over.moveGroup
        ? over.moveGroup(uniqueId, newParent, oldParent)
        : { success: true, errors: [] };
    },
    setShortcuts: async (input) => {
      calls.push({ op: 'setShortcuts', args: input });
      return over.setShortcuts ? over.setShortcuts(input) : { ok: true, revisionEditId: 9999 };
    },
    publish: async (id, revision) => {
      calls.push({ op: 'publish', args: { id, revision } });
      return over.publish ? over.publish(id, revision) : null;
    },
    processSummary: async (id) => {
      calls.push({ op: 'summary', args: id });
      if (over.processSummary) return over.processSummary(id);
      throw new Error('processSummary not stubbed');
    },
    childGroups: async (parent) => {
      calls.push({ op: 'childGroups', args: parent });
      return over.childGroups ? over.childGroups(parent) : [];
    },
  };

  const ops = () => calls.map((c) => c.op);
  return { gateway, calls, ops, writes: () => ops().filter((op) => op !== 'childGroups') };
}

// ------------------------------------------------------------ group plan

function create(over: Partial<CreateAction> = {}): CreateAction {
  return {
    seq: 0,
    path: ['Top'],
    display: 'Top',
    name: 'Top',
    parent: { kind: 'root' },
    line: 2,
    ...over,
  };
}

function groupPlan(creates: CreateAction[], blocked: GroupPlan['blocked'] = []): GroupPlan {
  return { creates, renames: [], moves: [], existing: [], blocked };
}

test('a group is created and then named, in that order', () => {
  const h = harness();
  return runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) }).then((summary) => {
    assert.deepEqual(h.writes(), ['validate', 'create', 'rename']);
    assert.equal(summary.outcomes[0]?.result, 'ok');
    assert.equal(summary.outcomes[0]?.targetId, 'new-1');
  });
});

test('the created id reaches the journal before the rename is attempted', async () => {
  // The property that makes an interrupted create a named thing rather than a mystery.
  const j = journal();
  let phaseAtRename: string | null = null;

  const h = harness({
    renameGroup: async () => {
      phaseAtRename = j.phaseOf('group.create:top');
      return { isValid: true };
    },
  });

  await runPlan(h.gateway, j, { groupPlan: groupPlan([create()]) });
  assert.equal(phaseAtRename, 'commit');
});

test('a child is hung off the parent created moments earlier', async () => {
  const h = harness();
  await runPlan(h.gateway, journal(), {
    groupPlan: groupPlan([
      create({ seq: 0, path: ['Top'], display: 'Top', name: 'Top' }),
      create({
        seq: 1,
        path: ['Top', 'Child'],
        display: 'Top | Child',
        name: 'Child',
        parent: { kind: 'planned', seq: 0, display: 'Top' },
      }),
    ]),
  });

  const creates = h.calls.filter((c) => c.op === 'create');
  assert.equal(creates[0]?.args, null, 'top level');
  assert.equal(creates[1]?.args, 'new-1', 'under the group just created');
});

test('a subtree is abandoned when its parent could not be created', async () => {
  // Creating the child at the root instead would be worse than not creating it.
  const h = harness({
    createGroup: async () => {
      throw new Error('nope');
    },
  });

  const summary = await runPlan(h.gateway, journal(), {
    groupPlan: groupPlan([
      create({ seq: 0 }),
      create({
        seq: 1,
        path: ['Top', 'Child'],
        display: 'Top | Child',
        name: 'Child',
        parent: { kind: 'planned', seq: 0, display: 'Top' },
      }),
    ]),
  });

  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.equal(summary.outcomes[1]?.result, 'skipped');
  assert.match(summary.outcomes[1]?.detail as string, /its parent "Top" was not created/);
  assert.equal(h.calls.filter((c) => c.op === 'create').length, 1);
});

test('a failed rename is reported loudly, because a re-run would duplicate the group', async () => {
  const h = harness({
    renameGroup: async () => {
      throw new Error('timeout');
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.match(summary.outcomes[0]?.detail as string, /group called "New Group"/);
  assert.match(summary.outcomes[0]?.detail as string, /before running this file again/);
  // The id is still known, so the operator can find it.
  assert.equal(summary.outcomes[0]?.targetId, 'new-1');
});

test('a server prompt is a skip, not something a bulk run answers', async () => {
  const h = harness({
    validateGroupAction: async () => ({
      isValid: true,
      isCancelled: false,
      isPrompt: true,
      title: null,
      message: 'This will change who can see things.',
      continueLabel: null,
      cancelLabel: null,
      additionalInfos: null,
      errorCode: null,
    }),
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  assert.equal(summary.outcomes[0]?.result, 'skipped');
  assert.deepEqual(h.writes(), ['validate']);
});

// -------------------------------------------------------------- resuming

test('a resumed run does not create the same group twice', async () => {
  const j = journal();
  const first = harness();
  await runPlan(first.gateway, j, { groupPlan: groupPlan([create()]) });

  const second = harness();
  const summary = await runPlan(second.gateway, j, { groupPlan: groupPlan([create()]) });

  assert.deepEqual(second.writes(), [], 'nothing re-sent');
  // Not "ok": the tenant is right, but this run did nothing, and a report that claims
  // otherwise is not an audit log.
  assert.equal(summary.outcomes[0]?.result, 'skipped');
  assert.match(summary.outcomes[0]?.detail as string, /earlier run/);
});

test('a resumed shortcut row reports that it was carried over, not applied', async () => {
  const j = journal();
  const first = harness();
  await runPlan(first.gateway, j, { shortcutPlan: shortcutPlan({ updates: [change()] }) });

  const second = harness();
  const summary = await runPlan(second.gateway, j, {
    shortcutPlan: shortcutPlan({ updates: [change()] }),
  });

  assert.deepEqual(second.writes(), [], 'nothing re-sent');
  assert.equal(summary.outcomes[0]?.result, 'skipped');
  assert.match(summary.outcomes[0]?.detail as string, /Already completed by an earlier run/);
});

test('a resume finishes a create whose rename never landed', async () => {
  const j = journal();
  const first = harness({
    renameGroup: async () => {
      throw new Error('tab closed');
    },
  });
  await runPlan(first.gateway, j, { groupPlan: groupPlan([create()]) });

  const second = harness();
  await runPlan(second.gateway, j, { groupPlan: groupPlan([create()]) });

  // Renamed, never re-created.
  assert.deepEqual(second.writes(), ['rename']);
  assert.deepEqual(second.calls[0]?.args, { uniqueId: 'new-1', name: 'Top' });
});

test('a create left in doubt is never repeated, and says how to fix it by hand', async () => {
  // A second CreateGroup would leave two indistinguishable orphans.
  const j = journal();
  j.append({ step: 'group.create:top', kind: 'group.create', phase: 'begin' });

  const h = harness();
  const summary = await runPlan(h.gateway, j, { groupPlan: groupPlan([create()]) });

  assert.deepEqual(h.writes(), []);
  assert.equal(summary.outcomes[0]?.result, 'skipped');
  assert.match(summary.outcomes[0]?.detail as string, /"New Group" under "the top level"/);
});

// --------------------------------------------------------- shortcut plan

function group(uniqueId: string, id: number, display: string): ResolvedGroup {
  return { uniqueId, id, name: display.split(' | ').pop() as string, display };
}

function change(over: Partial<ShortcutChange> = {}): ShortcutChange {
  return {
    line: 2,
    lines: [2],
    processUniqueId: PROCESS,
    processName: 'PQL via BDR',
    version: '2.3',
    revisionEditId: 9180,
    desired: [group('g-legal', 501, 'Legal | Compliance')],
    currentShortcuts: [],
    writePath: { kind: 'publish-direct' },
    fromPublished: true,
    ...over,
  };
}

function shortcutPlan(over: Partial<ShortcutPlan> = {}): ShortcutPlan {
  return {
    updates: [],
    clears: [],
    unchanged: [],
    blocked: [],
    warnings: [],
    published: 'republish',
    ...over,
  };
}

function summaryFor(over: Partial<ProcessSummary> = {}): ProcessSummary {
  return {
    uniqueId: PROCESS,
    name: 'PQL via BDR',
    version: '2.3',
    revisionEditId: 9180,
    revisionStateId: 3,
    homeGroupUniqueId: 'home',
    homeGroupName: 'Home',
    currentShortcuts: [],
    canEdit: true,
    canSave: true,
    canPublishAfterEdit: true,
    canSubmitForApprovalAfterEdit: true,
    ...over,
  };
}

test('a published process is saved and then published', async () => {
  const h = harness();
  const summary = await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({ updates: [change()] }),
  });

  assert.deepEqual(h.ops(), ['setShortcuts', 'publish']);
  assert.deepEqual((h.calls[1] as Call).args, { id: PROCESS, revision: 9999 });
  assert.equal(summary.outcomes[0]?.result, 'ok');
  assert.equal(summary.outcomes[0]?.after, '3.0');
});

test('an in-progress process is saved and never published', async () => {
  const h = harness();
  const summary = await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({ updates: [change({ version: '1.4', writePath: { kind: 'save-only' } })] }),
  });

  assert.deepEqual(h.ops(), ['setShortcuts']);
  assert.equal(summary.outcomes[0]?.after, '1.5');
});

test('the approval route asks for approval on the save itself', async () => {
  const h = harness();
  await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({ updates: [change({ writePath: { kind: 'submit-then-publish' } })] }),
  });

  const input = h.calls[0]?.args as SetShortcutsInput;
  assert.equal(input.submitForApproval, true);
  assert.deepEqual(h.ops(), ['setShortcuts', 'publish']);
});

test('the revision the plan was built against is what gets sent', async () => {
  // The optimistic-concurrency check lives server-side, but it is only as good as the
  // number the client sends.
  const h = harness();
  await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({ updates: [change({ revisionEditId: 4242 })] }),
  });

  assert.equal((h.calls[0]?.args as SetShortcutsInput).expectedRevisionEditId, 4242);
});

test('a process edited since the preview is skipped, not overwritten', async () => {
  const h = harness({
    setShortcuts: async () => ({ ok: false, conflict: { expected: 9180, actual: 9200 } }),
  });

  const summary = await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({ updates: [change()] }),
  });

  assert.deepEqual(h.ops(), ['setShortcuts'], 'never published');
  assert.equal(summary.outcomes[0]?.result, 'skipped');
  assert.match(summary.outcomes[0]?.detail as string, /Changed by someone else/);
});

test('a save that succeeds but a publish that fails says so precisely', async () => {
  // "Failed" alone would be a lie: the change is in the process, just not live.
  const h = harness({
    publish: async () => {
      throw new Error('503');
    },
  });

  const summary = await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({ updates: [change()] }),
  });

  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.match(summary.outcomes[0]?.detail as string, /in the process but not published/);
  assert.equal(summary.outcomes[0]?.after, '', 'no version claimed for a failure');
});

test('a clear sends an empty shortcut list', async () => {
  const h = harness();
  const summary = await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({ clears: [change({ desired: [] })] }),
  });

  assert.deepEqual((h.calls[0]?.args as SetShortcutsInput).shortcuts, []);
  assert.equal(summary.outcomes[0]?.action, 'shortcuts.clear');
});

test('a save on a published process says the live version was left alone', async () => {
  // "Saved as a draft" alone would read as done, and the shortcut is not live yet.
  const h = harness();
  const summary = await runPlan(h.gateway, journal(), {
    shortcutPlan: shortcutPlan({
      updates: [change({ writePath: { kind: 'save-only' }, fromPublished: true })],
    }),
  });

  assert.equal(h.calls.filter((c) => c.op === 'publish').length, 0);
  assert.equal(summary.outcomes[0]?.result, 'ok');
  assert.match(summary.outcomes[0]?.detail as string, /published version still has its old shortcuts/);
});

// -------------------------------------------------- interrupted writes

test('an interrupted write that landed is not written again', async () => {
  const j = journal();
  j.append({ step: `shortcuts:${PROCESS}`, kind: 'shortcuts.write', phase: 'begin' });

  const h = harness({
    processSummary: async () =>
      summaryFor({
        currentShortcuts: [{ Id: 501, UniqueId: 'g-legal', Name: 'Compliance' }],
        revisionEditId: 9181,
      }),
  });

  const summary = await runPlan(h.gateway, j, { shortcutPlan: shortcutPlan({ updates: [change()] }) });

  // Reconciled from the tenant, then only the publish remained.
  assert.deepEqual(h.ops(), ['summary', 'publish']);
  assert.deepEqual((h.calls[1] as Call).args, { id: PROCESS, revision: 9181 });
  assert.equal(summary.outcomes[0]?.result, 'ok');
});

test('an interrupted write that never landed is retried', async () => {
  const j = journal();
  j.append({ step: `shortcuts:${PROCESS}`, kind: 'shortcuts.write', phase: 'begin' });

  const h = harness({ processSummary: async () => summaryFor({ currentShortcuts: [] }) });
  await runPlan(h.gateway, j, { shortcutPlan: shortcutPlan({ updates: [change()] }) });

  assert.deepEqual(h.ops(), ['summary', 'setShortcuts', 'publish']);
});

test('an interrupted publish is never repeated', async () => {
  // A second publish would burn another major version on a process that may already
  // be correct.
  const j = journal();
  j.append({
    step: `shortcuts:${PROCESS}`,
    kind: 'shortcuts.write',
    phase: 'commit',
    data: { revisionEditId: 9181 },
  });
  j.append({ step: `publish:${PROCESS}`, kind: 'process.publish', phase: 'begin' });

  const h = harness();
  const summary = await runPlan(h.gateway, j, { shortcutPlan: shortcutPlan({ updates: [change()] }) });

  assert.deepEqual(h.writes(), []);
  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.match(summary.outcomes[0]?.detail as string, /not certain the publish completed/);
});

// ----------------------------------------------------------- stopping

test('a dead session stops the run instead of failing every remaining row', async () => {
  const signedOut = Object.assign(new Error('Not signed in.'), { signedOut: true });
  const h = harness({
    setShortcuts: async () => {
      throw signedOut;
    },
  });

  const summary = await runPlan(
    h.gateway,
    journal(),
    {
      shortcutPlan: shortcutPlan({
        updates: [change({ line: 2 }), change({ line: 3, processUniqueId: 'other' })],
      }),
    },
    { concurrency: 1 },
  );

  assert.equal(summary.stopped, true);
  assert.match(summary.stoppedReason as string, /session ended/);
  assert.equal(summary.outcomes.length, 1, 'the second row was never attempted');
});

test('cancelling stops between batches and says what it left behind', async () => {
  const controller = new AbortController();
  const h = harness({
    setShortcuts: async (input) => {
      controller.abort();
      return { ok: true, revisionEditId: 1 + input.expectedRevisionEditId };
    },
  });

  const summary = await runPlan(
    h.gateway,
    journal(),
    {
      shortcutPlan: shortcutPlan({
        updates: [change({ line: 2 }), change({ line: 3, processUniqueId: 'other' })],
      }),
    },
    { concurrency: 1, signal: controller.signal },
  );

  assert.equal(summary.stopped, true);
  assert.match(summary.stoppedReason as string, /Anything already written stays written/);
  assert.equal(summary.outcomes.length, 1);
});

test('groups finish before any shortcut is written', async () => {
  // Shortcut targets may be groups created moments earlier.
  const h = harness();
  await runPlan(h.gateway, journal(), {
    groupPlan: groupPlan([create()]),
    shortcutPlan: shortcutPlan({ updates: [change()] }),
  });

  assert.deepEqual(h.writes(), ['validate', 'create', 'rename', 'setShortcuts', 'publish']);
});

test('a failure in the group phase does not stop the shortcut phase', async () => {
  const h = harness({
    renameGroup: async () => {
      throw new Error('nope');
    },
  });

  const summary = await runPlan(h.gateway, journal(), {
    groupPlan: groupPlan([create()]),
    shortcutPlan: shortcutPlan({ updates: [change()] }),
  });

  assert.equal(summary.stopped, false);
  assert.equal(summary.outcomes.filter((o: Outcome) => o.type === 'process').length, 1);
});

test('nothing outside the plan is ever touched', async () => {
  const h = harness();
  await runPlan(h.gateway, journal(), { groupPlan: groupPlan([], [{ line: 5, display: 'X', message: 'no' }]) });
  assert.deepEqual(h.writes(), []);
});

// ------------------------------------------------------- orphan recovery

test('a create that errors but actually landed is recovered, not repeated', async () => {
  // The product's known failure: creating a lot of groups at once, some report an
  // error and then turn up named "New Group".
  const tree = liveTree();
  let attempts = 0;

  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      attempts++;
      // It made the group, then failed to tell us.
      tree.add(parent, 'g-orphan', 'New Group');
      throw new Error('504 Gateway Timeout');
    },
    renameGroup: async (uniqueId, name) => {
      tree.rename(null, uniqueId, name);
      return { isValid: true };
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });

  assert.equal(attempts, 1, 'never sent a second create');
  assert.equal(summary.outcomes[0]?.result, 'ok');
  assert.equal(summary.outcomes[0]?.targetId, 'g-orphan');
  assert.match(summary.outcomes[0]?.detail as string, /had in fact been created/);
  assert.equal(tree.titleOf(null, 'g-orphan'), 'Top', 'the orphan got its real name');
});

test('a create that genuinely failed is not confused with one that landed', async () => {
  const tree = liveTree();
  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async () => {
      throw new Error('500');
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.deepEqual(h.ops().filter((o) => o === 'rename'), [], 'nothing renamed');
});

test('a placeholder that was already there is never adopted', async () => {
  // Renaming a group somebody else made would be unrecoverable. Recovery is anchored
  // to a snapshot taken immediately before the create, so a pre-existing orphan is
  // visibly not ours.
  const tree = liveTree();
  tree.add(null, 'g-someone-elses', 'New Group');

  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async () => {
      throw new Error('504');
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.equal(tree.titleOf(null, 'g-someone-elses'), 'New Group', 'left alone');
});

test('two placeholders appearing at once is reported rather than guessed at', async () => {
  // A concurrent run. Picking one would rename a stranger's group.
  const tree = liveTree();
  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      tree.add(parent, 'g-a', 'New Group');
      tree.add(parent, 'g-b', 'New Group');
      throw new Error('504');
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.equal(tree.titleOf(null, 'g-a'), 'New Group');
  assert.equal(tree.titleOf(null, 'g-b'), 'New Group');
});

test('a resume recovers an orphan left by an interrupted create', async () => {
  const tree = liveTree();

  // First run: the create lands but the tab dies before the response.
  const j = journal();
  const first = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      tree.add(parent, 'g-orphan', 'New Group');
      throw Object.assign(new Error('Not signed in.'), { signedOut: true });
    },
  });
  await runPlan(first.gateway, j, { groupPlan: groupPlan([create()]) });

  // Wipe the commit so the journal looks like it died mid-create.
  const entries = j.entries().filter((e) => e.phase !== 'commit' && e.phase !== 'fail');
  const resumed = Journal.start('run-2', 'demo', 2_000, null);
  for (const entry of entries) resumed.append(entry);

  const second = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    renameGroup: async (uniqueId, name) => {
      tree.rename(null, uniqueId, name);
      return { isValid: true };
    },
  });
  const summary = await runPlan(second.gateway, resumed, { groupPlan: groupPlan([create()]) });

  assert.equal(second.ops().filter((o) => o === 'create').length, 0, 'no second create');
  assert.equal(tree.titleOf(null, 'g-orphan'), 'Top');
  assert.equal(summary.outcomes[0]?.result, 'ok');
});

// -------------------------------------------------- verifying the names

test('a rename that reports success but does not stick is caught and retried', async () => {
  // RenameGroup can return 200 without the name taking. A group left as "New Group"
  // is invisible to the next run, which would then create a second one.
  const tree = liveTree();
  let renames = 0;

  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      tree.add(parent, 'g-new', 'New Group');
      return { isValid: true, parentGroupId: parent, groupid: 'g-new', groupName: 'New Group' };
    },
    renameGroup: async (uniqueId, name) => {
      renames++;
      // The first attempt silently does nothing.
      if (renames > 1) tree.rename(null, uniqueId, name);
      return { isValid: true };
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });

  assert.equal(renames, 2);
  assert.equal(tree.titleOf(null, 'g-new'), 'Top');
  assert.equal(summary.outcomes[0]?.result, 'ok');
  assert.equal(summary.outcomes[0]?.action, 'create.recovered');
  assert.match(summary.outcomes[0]?.detail as string, /second attempt/);
});

test('a group that hits both faults keeps the evidence of both', async () => {
  // The create lies, then the rename lies too. Reporting only the second would hide
  // half of what this tenant did.
  const tree = liveTree();
  let renames = 0;

  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      tree.add(parent, 'g-new', 'New Group');
      throw new Error('504');
    },
    renameGroup: async (uniqueId, name) => {
      renames++;
      if (renames > 1) tree.rename(null, uniqueId, name);
      return { isValid: true };
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  const detail = summary.outcomes[0]?.detail as string;

  assert.equal(summary.outcomes[0]?.result, 'ok');
  assert.match(detail, /had in fact been created/);
  assert.match(detail, /second attempt/);
  assert.equal(tree.titleOf(null, 'g-new'), 'Top');
});

test('a name that will not stick at all is reported with what to do about it', async () => {
  const tree = liveTree();
  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      tree.add(parent, 'g-new', 'New Group');
      return { isValid: true, parentGroupId: parent, groupid: 'g-new', groupName: 'New Group' };
    },
    renameGroup: async () => ({ isValid: true }),
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  assert.equal(summary.outcomes[0]?.result, 'failed');
  assert.match(summary.outcomes[0]?.detail as string, /still called "New Group"/);
  assert.match(summary.outcomes[0]?.detail as string, /create a second copy/);
});

test('an unrelated orphan under a touched parent is reported', async () => {
  const tree = liveTree();
  tree.add(null, 'g-old-orphan', 'New Group');

  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      tree.add(parent, 'g-new', 'New Group');
      return { isValid: true, parentGroupId: parent, groupid: 'g-new', groupName: 'New Group' };
    },
    renameGroup: async (uniqueId, name) => {
      tree.rename(null, uniqueId, name);
      return { isValid: true };
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  const orphan = summary.outcomes.find((o) => o.action === 'orphan.found');

  assert.equal(orphan?.targetId, 'g-old-orphan');
  assert.match(orphan?.detail as string, /did not create it/);
});

test('verification costs one read per parent, not one per group', async () => {
  const tree = liveTree();
  let created = 0;

  const h = harness({
    childGroups: async (parent) => tree.childrenOf(parent),
    createGroup: async (parent) => {
      created++;
      const uniqueId = `g-${created}`;
      tree.add(parent, uniqueId, 'New Group');
      return { isValid: true, parentGroupId: parent, groupid: uniqueId, groupName: 'New Group' };
    },
    renameGroup: async (uniqueId, name) => {
      tree.rename(null, uniqueId, name);
      return { isValid: true };
    },
  });

  await runPlan(h.gateway, journal(), {
    groupPlan: groupPlan([
      create({ seq: 0, path: ['A'], display: 'A', name: 'A' }),
      create({ seq: 1, path: ['B'], display: 'B', name: 'B' }),
      create({ seq: 2, path: ['C'], display: 'C', name: 'C' }),
    ]),
  });

  const reads = h.ops().filter((o) => o === 'childGroups').length;
  // Three snapshots before the writes, plus one verification sweep over one parent.
  assert.equal(reads, 4);
});

test('a tree that cannot be read degrades rather than blocking the run', async () => {
  // Losing the safety net is bad; refusing to create anything is worse.
  const h = harness({
    childGroups: async () => {
      throw new Error('tree unavailable');
    },
  });

  const summary = await runPlan(h.gateway, journal(), { groupPlan: groupPlan([create()]) });
  assert.equal(summary.outcomes[0]?.result, 'ok');
});

// -------------------------------------------------------- renames & moves

function rename(over: Partial<GroupPlan['renames'][number]> = {}): GroupPlan['renames'][number] {
  return {
    uniqueId: 'g-finance',
    fromDisplay: 'Crestan | Finance',
    from: 'Finance',
    to: 'Finance & Legal',
    line: 2,
    ...over,
  };
}

function move(over: Partial<GroupPlan['moves'][number]> = {}): GroupPlan['moves'][number] {
  return {
    uniqueId: 'g-finance',
    name: 'Finance',
    fromDisplay: 'Crestan | Finance',
    fromParentUniqueId: 'g-crestan',
    toPath: ['Operations', 'Finance'],
    toDisplay: 'Operations | Finance',
    toParent: { kind: 'existing', uniqueId: 'g-ops', display: 'Operations' },
    line: 2,
    ...over,
  };
}

test('renames run before creates, and moves after them', () => {
  // A move may be putting a group inside a parent this same run creates, so the
  // destination has to exist by the time the move is sent.
  const h = harness();
  const plan: GroupPlan = {
    creates: [create()],
    renames: [rename()],
    moves: [move()],
    existing: [],
    blocked: [],
  };

  return runPlan(h.gateway, journal(), { groupPlan: plan }).then(() => {
    assert.deepEqual(h.writes(), ['rename', 'validate', 'create', 'rename', 'move']);
  });
});

test('a move sends both its old and new parent', () => {
  // ReorderTreeNodes wants OriginalParentUniqueId; without it the server cannot detach
  // the node from where it was.
  const h = harness();
  return runPlan(h.gateway, journal(), {
    groupPlan: { creates: [], renames: [], moves: [move()], existing: [], blocked: [] },
  }).then(() => {
    const sent = h.calls.find((c) => c.op === 'move');
    assert.deepEqual(sent?.args, {
      uniqueId: 'g-finance',
      newParent: 'g-ops',
      oldParent: 'g-crestan',
    });
  });
});

test('a move into a group this run creates waits for its real id', () => {
  const h = harness();
  const plan: GroupPlan = {
    creates: [create({ seq: 0, path: ['Shared'], display: 'Shared', name: 'Shared' })],
    renames: [],
    moves: [
      move({
        toParent: { kind: 'planned', seq: 0, display: 'Shared' },
        toDisplay: 'Shared | Finance',
      }),
    ],
    existing: [],
    blocked: [],
  };

  return runPlan(h.gateway, journal(), { groupPlan: plan }).then((summary) => {
    const sent = h.calls.find((c) => c.op === 'move');
    // "new-1" is the id the stubbed CreateGroup handed back moments earlier.
    assert.equal((sent?.args as { newParent: string }).newParent, 'new-1');
    assert.equal(summary.outcomes.find((o) => o.action === 'move')?.result, 'ok');
  });
});

test('a move whose new parent was never created is skipped, not sent to the root', () => {
  // Moving it to the top level instead would scatter the tree rather than restructure it.
  const h = harness({
    createGroup: async () => {
      throw new Error('nope');
    },
  });
  const plan: GroupPlan = {
    creates: [create({ seq: 0, path: ['Shared'], display: 'Shared', name: 'Shared' })],
    renames: [],
    moves: [move({ toParent: { kind: 'planned', seq: 0, display: 'Shared' } })],
    existing: [],
    blocked: [],
  };

  return runPlan(h.gateway, journal(), { groupPlan: plan }).then((summary) => {
    assert.equal(h.ops().includes('move'), false);
    const outcome = summary.outcomes.find((o) => o.action === 'move');
    assert.equal(outcome?.result, 'skipped');
    assert.match(outcome?.detail as string, /was not created/);
  });
});

test('a refusal that arrives as success:false is reported, not treated as done', () => {
  // The endpoint answers with a body, not an HTTP status, so a refusal is a 200.
  const h = harness({
    moveGroup: async () => ({ success: false, errors: ['Insufficient permission'] }),
  });

  return runPlan(h.gateway, journal(), {
    groupPlan: { creates: [], renames: [], moves: [move()], existing: [], blocked: [] },
  }).then((summary) => {
    const outcome = summary.outcomes.find((o) => o.action === 'move');
    assert.equal(outcome?.result, 'failed');
    assert.match(outcome?.detail as string, /Insufficient permission/);
  });
});

test('an interrupted move is reported rather than repeated', () => {
  // Re-sending one whose outcome we never learned could reparent a group someone has
  // since put back by hand.
  const j = journal();
  j.append({ step: step.groupMove('g-finance'), kind: 'group.move', phase: 'begin' });

  const h = harness();
  return runPlan(h.gateway, j, {
    groupPlan: { creates: [], renames: [], moves: [move()], existing: [], blocked: [] },
  }).then((summary) => {
    assert.equal(h.ops().includes('move'), false);
    const outcome = summary.outcomes.find((o) => o.action === 'move');
    assert.equal(outcome?.result, 'failed');
    assert.match(outcome?.detail as string, /not certain whether it happened/);
  });
});

test('a move already committed in this tab is not sent again', () => {
  const j = journal();
  j.append({ step: step.groupMove('g-finance'), kind: 'group.move', phase: 'commit' });

  const h = harness();
  return runPlan(h.gateway, j, {
    groupPlan: { creates: [], renames: [], moves: [move()], existing: [], blocked: [] },
  }).then((summary) => {
    assert.equal(h.ops().includes('move'), false);
    assert.equal(summary.outcomes.find((o) => o.action === 'move')?.result, 'skipped');
  });
});

test('a rename of an existing group records what it was called before', () => {
  const h = harness();
  return runPlan(h.gateway, journal(), {
    groupPlan: { creates: [], renames: [rename()], moves: [], existing: [], blocked: [] },
  }).then((summary) => {
    const outcome = summary.outcomes.find((o) => o.action === 'rename');
    assert.equal(outcome?.result, 'ok');
    assert.equal(outcome?.before, 'Finance');
    assert.equal(outcome?.after, 'Finance & Legal');
  });
});
