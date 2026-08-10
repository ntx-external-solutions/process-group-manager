/**
 * The append-only record of what a run actually did.
 *
 * This exists because two of the writes in this tool are not atomic, and because the
 * thing driving them is a browser tab that can be closed mid-run. Without a journal,
 * a interrupted run leaves a tenant in a state nobody can describe: some processes
 * republished, some not, and no way to tell which.
 *
 * The critical entry is `group.create`. Creating a group is CreateGroup (which makes a
 * group literally named "New Group") followed by RenameGroup. A failure between the
 * two leaves an orphan indistinguishable from a legitimate group — so the returned
 * uniqueId is committed to the journal *before* the rename is attempted, which is what
 * turns "something might exist somewhere" into a named thing an operator can go fix.
 *
 * Every step is idempotent by identity: replaying a journal tells the runner exactly
 * which steps are already done, so a resume never writes the same change twice.
 */

export type ActionKind = 'group.create' | 'group.rename' | 'shortcuts.write' | 'process.publish';

export type Phase =
  /** Sent, outcome unknown. A begin with no terminal phase is the recovery case. */
  | 'begin'
  | 'commit'
  | 'fail'
  /** Deliberately not attempted. Terminal, and not an error. */
  | 'skip';

export interface JournalEntry {
  /** Stable identity for the step, independent of ordering. */
  step: string;
  kind: ActionKind;
  phase: Phase;
  /** Small, structured, and never credentials. */
  data?: Record<string, string | number | boolean | null>;
}

/** Where the journal is mirrored. Injected so tests need no DOM. */
export interface JournalStore {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

export interface RunRecord {
  runId: string;
  /** Guards against replaying one tenant's run against another. */
  tenant: string;
  startedAt: number;
  entries: JournalEntry[];
}

const TERMINAL: ReadonlySet<Phase> = new Set<Phase>(['commit', 'fail', 'skip']);

export class Journal {
  readonly runId: string;
  readonly tenant: string;
  readonly startedAt: number;

  #entries: JournalEntry[];
  #store: JournalStore | null;

  constructor(record: RunRecord, store: JournalStore | null) {
    this.runId = record.runId;
    this.tenant = record.tenant;
    this.startedAt = record.startedAt;
    this.#entries = [...record.entries];
    this.#store = store;
  }

  static start(runId: string, tenant: string, startedAt: number, store: JournalStore | null): Journal {
    const journal = new Journal({ runId, tenant, startedAt, entries: [] }, store);
    journal.#persist();
    return journal;
  }

  append(entry: JournalEntry): void {
    this.#entries.push(entry);
    this.#persist();
  }

  entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  /** The most recent phase recorded for a step, or null if it was never attempted. */
  phaseOf(step: string): Phase | null {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i] as JournalEntry;
      if (entry.step === step) return entry.phase;
    }
    return null;
  }

  /** Data from the step's last committed entry — how a resume recovers a group's id. */
  commitData(step: string): Record<string, string | number | boolean | null> | null {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i] as JournalEntry;
      if (entry.step === step && entry.phase === 'commit') return entry.data ?? {};
    }
    return null;
  }

  /**
   * Data from the step's most recent entry, whatever phase it reached.
   *
   * How a resume recovers what a `begin` recorded — notably the list of groups that
   * existed before a create was attempted, which is what makes a stray "New Group"
   * identifiable as ours rather than someone else's.
   */
  latestData(step: string): Record<string, string | number | boolean | null> | null {
    for (let i = this.#entries.length - 1; i >= 0; i--) {
      const entry = this.#entries[i] as JournalEntry;
      if (entry.step === step) return entry.data ?? {};
    }
    return null;
  }

  /** True when the step reached a terminal phase and must not be attempted again. */
  isSettled(step: string): boolean {
    const phase = this.phaseOf(step);
    return phase !== null && TERMINAL.has(phase);
  }

  isCommitted(step: string): boolean {
    return this.phaseOf(step) === 'commit';
  }

  /**
   * Steps that were started and never finished.
   *
   * The tab died between sending a write and hearing back, so we cannot know whether
   * it landed. These are never retried automatically — a repeated CreateGroup would
   * leave a second orphan, and a repeated publish would burn another major version.
   */
  inDoubt(): JournalEntry[] {
    const latest = new Map<string, JournalEntry>();
    for (const entry of this.#entries) latest.set(entry.step, entry);
    return [...latest.values()].filter((entry) => entry.phase === 'begin');
  }

  discard(): void {
    this.#store?.clear();
  }

  #persist(): void {
    if (!this.#store) return;
    const record: RunRecord = {
      runId: this.runId,
      tenant: this.tenant,
      startedAt: this.startedAt,
      entries: this.#entries,
    };
    try {
      this.#store.write(JSON.stringify(record));
    } catch {
      // A full or unavailable store must not abort a run in progress. Losing the
      // ability to resume is bad; stopping halfway through writing is worse.
    }
  }
}

/**
 * Read a previous run back, or null if there is nothing usable.
 *
 * Anything unparseable, or belonging to a different tenant, is treated as absent —
 * replaying one tenant's steps against another would be the worst bug this tool could
 * have.
 */
export function loadJournal(store: JournalStore, tenant: string): Journal | null {
  let raw: string | null;
  try {
    raw = store.read();
  } catch {
    return null;
  }
  if (!raw) return null;

  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof record !== 'object' || record === null) return null;
  const candidate = record as Partial<RunRecord>;
  if (
    typeof candidate.runId !== 'string' ||
    typeof candidate.tenant !== 'string' ||
    typeof candidate.startedAt !== 'number' ||
    !Array.isArray(candidate.entries)
  ) {
    return null;
  }
  if (candidate.tenant !== tenant) return null;

  return new Journal(candidate as RunRecord, store);
}

/** sessionStorage, scoped to the tab and gone when it closes. */
export const SESSION_KEY = 'pgm.run';

export function sessionJournalStore(): JournalStore | null {
  if (typeof sessionStorage === 'undefined') return null;
  return {
    read: () => sessionStorage.getItem(SESSION_KEY),
    write: (value) => sessionStorage.setItem(SESSION_KEY, value),
    clear: () => sessionStorage.removeItem(SESSION_KEY),
  };
}

// ------------------------------------------------------------ step names

export const step = {
  groupCreate: (pathKey: string): string => `group.create:${pathKey}`,
  groupRename: (pathKey: string): string => `group.rename:${pathKey}`,
  shortcuts: (processUniqueId: string): string => `shortcuts:${processUniqueId}`,
  publish: (processUniqueId: string): string => `publish:${processUniqueId}`,
};
