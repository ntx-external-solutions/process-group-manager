import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Journal, loadJournal, step, type JournalStore } from './journal.ts';

function memoryStore(initial: string | null = null): JournalStore & { value: string | null } {
  const store = {
    value: initial,
    read: () => store.value,
    write: (v: string) => {
      store.value = v;
    },
    clear: () => {
      store.value = null;
    },
  };
  return store;
}

function journal(store: JournalStore | null = null): Journal {
  return Journal.start('run-1', 'demo', 1_000, store);
}

test('a step never attempted has no phase', () => {
  assert.equal(journal().phaseOf('anything'), null);
});

test('the latest phase for a step wins', () => {
  const j = journal();
  j.append({ step: 's', kind: 'group.create', phase: 'begin' });
  j.append({ step: 's', kind: 'group.create', phase: 'commit', data: { uniqueId: 'g-1' } });

  assert.equal(j.phaseOf('s'), 'commit');
  assert.equal(j.isCommitted('s'), true);
  assert.equal(j.isSettled('s'), true);
});

test('commit data is recoverable, which is how a resume finds a created group', () => {
  const j = journal();
  j.append({ step: 's', kind: 'group.create', phase: 'begin' });
  j.append({ step: 's', kind: 'group.create', phase: 'commit', data: { uniqueId: 'g-1' } });

  assert.deepEqual(j.commitData('s'), { uniqueId: 'g-1' });
});

test('failed and skipped are settled, so neither is retried', () => {
  const j = journal();
  j.append({ step: 'f', kind: 'group.create', phase: 'fail' });
  j.append({ step: 'k', kind: 'group.create', phase: 'skip' });

  assert.equal(j.isSettled('f'), true);
  assert.equal(j.isSettled('k'), true);
  assert.equal(j.isCommitted('f'), false);
});

test('a begin with no terminal phase is in doubt', () => {
  // The recovery case: the tab died between sending a write and hearing back.
  const j = journal();
  j.append({ step: 'hanging', kind: 'group.create', phase: 'begin' });
  j.append({ step: 'done', kind: 'group.create', phase: 'begin' });
  j.append({ step: 'done', kind: 'group.create', phase: 'commit' });

  assert.deepEqual(j.inDoubt().map((e) => e.step), ['hanging']);
});

// ---------------------------------------------------------- persistence

test('every append is mirrored, not just the last one', () => {
  // A run that dies mid-write must leave the earlier steps on disk.
  const store = memoryStore();
  const j = Journal.start('run-1', 'demo', 1_000, store);
  j.append({ step: 'a', kind: 'group.create', phase: 'commit', data: { uniqueId: 'g-1' } });

  const reloaded = loadJournal(store, 'demo');
  assert.equal(reloaded?.isCommitted('a'), true);
  assert.equal(reloaded?.runId, 'run-1');
});

test('a journal from another tenant is ignored', () => {
  // Replaying one tenant's steps against another is the worst bug available here.
  const store = memoryStore();
  Journal.start('run-1', 'tenant-a', 1_000, store).append({
    step: 'a',
    kind: 'group.create',
    phase: 'commit',
  });

  assert.equal(loadJournal(store, 'tenant-b'), null);
  assert.notEqual(loadJournal(store, 'tenant-a'), null);
});

test('unparseable or foreign storage reads as absent, not as an error', () => {
  assert.equal(loadJournal(memoryStore('not json'), 'demo'), null);
  assert.equal(loadJournal(memoryStore('{"runId":"x"}'), 'demo'), null);
  assert.equal(loadJournal(memoryStore(null), 'demo'), null);
});

test('a storage failure does not stop a run in progress', () => {
  // Losing the ability to resume is bad; stopping halfway through writing is worse.
  const store: JournalStore = {
    read: () => null,
    write: () => {
      throw new Error('QuotaExceededError');
    },
    clear: () => {},
  };

  const j = Journal.start('run-1', 'demo', 1_000, store);
  assert.doesNotThrow(() => j.append({ step: 'a', kind: 'group.create', phase: 'commit' }));
  assert.equal(j.isCommitted('a'), true);
});

test('step names are distinct per action and per target', () => {
  assert.notEqual(step.groupCreate('a'), step.groupRename('a'));
  assert.notEqual(step.shortcuts('p'), step.publish('p'));
  assert.notEqual(step.groupCreate('a'), step.groupCreate('b'));
});
