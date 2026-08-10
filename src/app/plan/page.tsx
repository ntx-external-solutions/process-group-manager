'use client';

/**
 * Choose a task, upload a file, see exactly what would happen — then apply it.
 *
 * Applying is the only thing on this page that writes, and it is unreachable until a
 * preview has been rendered: PLAN.md §8 makes "nothing writes before the preview is
 * shown" a rule, and the Apply button is driven by the same plan object the preview
 * was drawn from, so the two cannot disagree.
 *
 * Orchestration lives in the browser because there is no data backend and no server
 * job to hold a run: the tab drives every request through the proxy, one at a time.
 * That makes the tab itself the fragile part, which is what the journal is for.
 */

import { useEffect, useRef, useState } from 'react';

import { classifyCsv } from '@/lib/csv/detect.ts';
import { parseGroupCsv, type CsvIssue } from '@/lib/csv/groups.ts';
import { Journal, loadJournal, sessionJournalStore } from '@/lib/exec/journal.ts';
import { needsAttention, reportToCsv, summarise, type ReportSummary } from '@/lib/exec/report.ts';
import { runPlan, type Outcome, type RunProgress, type RunSummary } from '@/lib/exec/runner.ts';
import type { GroupPlan } from '@/lib/plan/groupPlan.ts';
import type { ShortcutPlan } from '@/lib/plan/shortcutPlan.ts';
import { parseProcessListCsv, toShortcutCsv } from '@/lib/csv/processList.ts';
import { parseShortcutCsv } from '@/lib/csv/shortcuts.ts';
import { groupTemplate, groupExport, shortcutTemplate } from '@/lib/csv/template.ts';
import { allPaths } from '@/lib/plan/tree.ts';
import {
  buildGroupPlan,
  buildShortcutPlan,
  loadRootTree,
  loadWholeTree,
  resolveShortcutTargets,
} from '@/lib/plan/orchestrate.ts';
import { datedFilename, downloadCsv, downloadText } from '@/lib/ui/download.ts';
import {
  browserExecGateway,
  browserGateway,
  currentSession,
  PmRequestError,
  topLevelGroupTitles,
  type SessionInfo,
} from '@/lib/ui/gateway.ts';
import {
  buildGroupPreview,
  buildShortcutPreview,
  groupPreviewToCsv,
  requiresClearConfirmation,
  shortcutPreviewToCsv,
  type GroupPreview,
  type ShortcutPreview,
} from '@/lib/ui/preview.ts';
import {
  buildStructurePreview,
  structureToText,
  type StructurePreview,
} from '@/lib/ui/structure.ts';
import {
  GroupPreviewView,
  IssueList,
  plural,
  RunResultView,
  ShortcutPreviewView,
} from './parts.tsx';

type Task = 'groups' | 'shortcuts';

interface ParseIssues {
  errors: CsvIssue[];
  warnings: CsvIssue[];
}

export default function PlanPage() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  const [task, setTask] = useState<Task | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [issues, setIssues] = useState<ParseIssues | null>(null);
  const [unreadable, setUnreadable] = useState<CsvIssue[]>([]);

  const [groupPreview, setGroupPreview] = useState<GroupPreview | null>(null);
  const [structure, setStructure] = useState<StructurePreview | null>(null);
  const [shortcutPreview, setShortcutPreview] = useState<ShortcutPreview | null>(null);
  const [clearsAcknowledged, setClearsAcknowledged] = useState(false);

  // The previews are for reading; these are what actually gets executed. Keeping both
  // from the same planning pass is what guarantees the run matches what was approved.
  const [groupPlan, setGroupPlan] = useState<GroupPlan | null>(null);
  const [shortcutPlan, setShortcutPlan] = useState<ShortcutPlan | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [unfinished, setUnfinished] = useState<Journal | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void currentSession().then((info) => {
      setSession(info);
      setCheckingSession(false);
      if (!info) return;
      // A journal that outlived its run means the tab was closed, or the session died,
      // partway through writing.
      const store = sessionJournalStore();
      const previous = store ? loadJournal(store, info.tenant) : null;
      if (previous && previous.entries().length > 0) setUnfinished(previous);
    });
  }, []);

  /**
   * The browser's own "are you sure" dialogue, which is the only thing that can
   * interrupt a close. Registered only while writing.
   */
  useEffect(() => {
    if (!running) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [running]);

  const working = busy !== null;

  /** Clear everything downstream of the file, so a stale preview can never linger. */
  function resetResults() {
    setError(null);
    setNote(null);
    setIssues(null);
    setUnreadable([]);
    setGroupPreview(null);
    setStructure(null);
    setShortcutPreview(null);
    setGroupPlan(null);
    setShortcutPlan(null);
    setClearsAcknowledged(false);
    setRunSummary(null);
    setProgress(null);
  }

  function chooseTask(next: Task) {
    resetResults();
    setFileName(null);
    setTask(next);
  }

  function handleFailure(cause: unknown) {
    if (cause instanceof PmRequestError) {
      setError([cause.message, cause.detail].filter(Boolean).join(' — '));
      // Only an actually-rejected session sends them back to sign in.
      if (cause.signedOut) setSession(null);
      return;
    }
    setError(cause instanceof Error ? cause.message : 'Something went wrong.');
  }

  // ------------------------------------------------------------ downloads

  async function downloadCurrentStructure() {
    setBusy('Reading the group tree…');
    resetResults();
    try {
      const tree = await loadWholeTree(browserGateway(), {
        onProgress: (event) => setBusy(`Reading the group tree… ${event.done} groups`),
      });
      const paths = allPaths(tree);
      downloadCsv(datedFilename('group-structure'), groupExport(paths));
      setNote(`Downloaded ${paths.length.toLocaleString()} existing group paths.`);
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setBusy(null);
    }
  }

  // --------------------------------------------------------------- upload

  async function onFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Let the same file be re-selected after an edit in Excel.
    event.target.value = '';
    if (!file || task === null) return;

    resetResults();
    setFileName(file.name);
    setBusy('Reading the file…');

    try {
      const text = await file.text();
      const kind = classifyCsv(text).kind;

      if (task === 'groups') {
        if (kind === 'shortcut-file' || kind === 'process-list') {
          setError(
            'That is a shortcuts file. Choose "Process shortcuts" above, or upload a ' +
              'file with one group path per row.',
          );
          return;
        }
        await planGroups(text);
        return;
      }

      if (kind === 'group-file') {
        setError(
          'That is a group-structure file. Choose "Group structure" above, or upload a ' +
            'file with Shortcut columns.',
        );
        return;
      }
      if (kind === 'process-list') {
        // They uploaded Process Manager's export. It cannot express intent — it has no
        // Shortcut columns — so convert it into the file that can and hand it back.
        await convertProcessList(text);
        return;
      }
      if (kind === 'unknown') {
        setError(
          'This file has no "Shortcut 1" column and is not a Process List export, so ' +
            'there is nothing to apply. Download the template below to see the format.',
        );
        return;
      }
      await planShortcuts(text);
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setBusy(null);
    }
  }

  async function planGroups(text: string) {
    const parsed = parseGroupCsv(text);
    setIssues({ errors: parsed.errors, warnings: parsed.warnings });
    if (parsed.errors.length > 0) return;

    setBusy('Checking which groups already exist…');
    const { plan, tree } = await buildGroupPlan(browserGateway(), parsed.rows, (event) =>
      setBusy(`Checking which groups already exist… ${event.done} levels`),
    );
    setGroupPreview(buildGroupPreview(plan));
    setGroupPlan(plan);
    // The tree is what makes "what will this look like" answerable; the plan alone
    // only knows the paths, not what already sits beside them.
    setStructure(buildStructurePreview(tree, plan));
  }

  async function planShortcuts(text: string) {
    const parsed = parseShortcutCsv(text);
    setIssues({ errors: parsed.errors, warnings: parsed.warnings });
    if (parsed.errors.length > 0) return;

    const gateway = browserGateway();

    setBusy('Finding the groups your file names…');
    const tree = await loadRootTree(gateway);
    // No group plan runs alongside this upload, so every shortcut target must already
    // exist; the planner reports the ones that do not, per row.
    const groups = await resolveShortcutTargets(gateway, parsed.rows, tree, []);

    setBusy('Reading the processes…');
    const { plan, unreadable: failures } = await buildShortcutPlan(gateway, parsed.rows, groups, {
      onProgress: (event) =>
        setBusy(`Reading the processes… ${event.done} of ${event.total ?? '?'}`),
    });

    setUnreadable(
      failures.map((f) => ({
        line: f.line,
        message: `Could not read process ${f.processUniqueId}: ${f.message}`,
      })),
    );
    setShortcutPreview(buildShortcutPreview(plan));
    setShortcutPlan(plan);
  }

  async function convertProcessList(text: string) {
    setBusy('Reading the top-level groups…');
    // Without these the leading path segment has to be guessed at, which silently
    // re-homes everything when the export was filtered to one top-level group.
    const topLevel = await topLevelGroupTitles();

    const result = parseProcessListCsv(text, { topLevelGroups: topLevel });
    setIssues({ errors: result.errors, warnings: result.warnings });
    if (result.errors.length > 0) return;

    downloadCsv(datedFilename('process-shortcuts'), toShortcutCsv(result.processes));
    const withShortcuts = result.processes.filter((p) => p.shortcutPaths.length > 0).length;
    setNote(
      `That was Process Manager's Process List export, so we turned it into a file you ` +
        `can edit: ${result.processes.length.toLocaleString()} processes, ` +
        `${withShortcuts.toLocaleString()} of them with shortcuts already filled in. ` +
        `Edit it in Excel and upload it here again.`,
    );
  }

  // ------------------------------------------------------------- applying

  async function apply() {
    if (!session || running) return;

    // Continue an unfinished run rather than starting a fresh journal: steps that
    // already completed must not be attempted twice.
    const journal =
      unfinished ??
      Journal.start(`run-${Date.now()}`, session.tenant, Date.now(), sessionJournalStore());

    const controller = new AbortController();
    abortRef.current = controller;

    setRunning(true);
    setError(null);
    setRunSummary(null);
    setProgress(null);

    try {
      const summary = await runPlan(
        browserExecGateway(),
        journal,
        { groupPlan, shortcutPlan },
        { onProgress: setProgress, signal: controller.signal },
      );

      setRunSummary(summary);
      setUnfinished(summary.stopped ? journal : null);
      // Only a run that finished may forget itself. A stopped one is exactly what the
      // journal is for.
      if (!summary.stopped) journal.discard();
    } catch (cause) {
      // runPlan reports per-action failures rather than throwing, so reaching here
      // means something went wrong around the run, not inside it.
      setUnfinished(journal);
      handleFailure(cause);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function downloadReport() {
    downloadCsv(
      datedFilename(groupPlan ? 'group-run-report' : 'shortcut-run-report'),
      reportToCsv({ outcomes: runSummary?.outcomes ?? [], groupPlan, shortcutPlan }),
    );
  }

  // ----------------------------------------------------------------- view

  if (checkingSession) {
    return (
      <main>
        <h1>Plan a change</h1>
        <p className="lede">Checking your session…</p>
      </main>
    );
  }

  if (session === null) {
    return (
      <main>
        <h1>Plan a change</h1>
        <p className="lede">You need to be signed in to your Process Manager tenant.</p>
        <div className="panel">
          <h2>Not signed in</h2>
          <p>
            <a href="/signin">Sign in</a> and come back. Your session is held in a cookie
            and nothing is stored on the server.
          </p>
        </div>
      </main>
    );
  }

  const preview = groupPreview ?? shortcutPreview;
  const needsClearAck = shortcutPreview !== null && requiresClearConfirmation(shortcutPreview);
  const canApply =
    preview !== null &&
    !preview.isNoOp &&
    !running &&
    runSummary === null &&
    (!needsClearAck || clearsAcknowledged);

  return (
    <main>
      <h1>Plan a change</h1>
      <p className="lede">
        Signed in as {session.username} — tenant <code>{session.tenant}</code>. Nothing is
        written until you press Apply.
      </p>

      {unfinished !== null && runSummary === null && (
        <div className="panel warning">
          <h2>A previous run in this tab did not finish</h2>
          <p>
            Upload the same file again and apply it — anything that already completed is
            skipped rather than repeated. If you would rather start clean, discard it
            first; steps that already ran will then be attempted a second time.
          </p>
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => {
                unfinished.discard();
                setUnfinished(null);
              }}
              disabled={running}
            >
              Discard that run
            </button>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>1. What are you changing?</h2>
        <div className="row">
          <button
            type="button"
            className={task === 'groups' ? '' : 'secondary'}
            onClick={() => chooseTask('groups')}
            disabled={working}
          >
            Group structure
          </button>
          <button
            type="button"
            className={task === 'shortcuts' ? '' : 'secondary'}
            onClick={() => chooseTask('shortcuts')}
            disabled={working}
          >
            Process shortcuts
          </button>
        </div>
      </div>

      {task === 'groups' && (
        <div className="panel">
          <h2>2. Start from a file</h2>
          <p>
            One group path per row, levels separated by <code>|</code>. Groups that already
            exist are left alone — this never renames, moves, or deletes anything.
          </p>
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => downloadCsv('group-structure-template.csv', groupTemplate())}
              disabled={working}
            >
              Download template
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => void downloadCurrentStructure()}
              disabled={working}
            >
              Download current structure
            </button>
          </div>
        </div>
      )}

      {task === 'shortcuts' && (
        <div className="panel">
          <h2>2. Start from a file</h2>
          <p>
            The best starting point is your own data. In Process Manager, export the
            Process List report with shortcuts included, then upload it below — we will
            turn it into an editable file with every process&rsquo;s current shortcuts
            already filled in, so any row you do not touch changes nothing.
          </p>
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => downloadCsv('process-shortcuts-template.csv', shortcutTemplate())}
              disabled={working}
            >
              Download blank template
            </button>
          </div>
        </div>
      )}

      {task !== null && (
        <div className="panel">
          <h2>3. Upload your file</h2>
          <p>
            {task === 'shortcuts'
              ? 'Either your edited shortcuts file, or a Process List export to convert.'
              : 'A CSV with one group path per row.'}
          </p>
          <input type="file" accept=".csv,text/csv" onChange={onFile} disabled={working} />
          {fileName !== null && <p className="filename">{fileName}</p>}
        </div>
      )}

      {working && (
        <div className="panel">
          <h2>Working</h2>
          <p>{busy}</p>
        </div>
      )}

      {error !== null && (
        <div className="panel error">
          <h2>Problem</h2>
          <p>{error}</p>
        </div>
      )}

      {note !== null && (
        <div className="panel">
          <h2>Done</h2>
          <p>{note}</p>
        </div>
      )}

      {issues !== null && (
        <>
          <IssueList title="Errors in the file" issues={issues.errors} tone="error" />
          <IssueList title="Warnings" issues={issues.warnings} tone="warning" />
        </>
      )}

      <IssueList title="Processes that could not be read" issues={unreadable} tone="warning" />

      {groupPreview !== null && (
        <>
          <h2 className="section">What would happen</h2>
          <GroupPreviewView preview={groupPreview} structure={structure} />
        </>
      )}

      {shortcutPreview !== null && (
        <>
          <h2 className="section">What would happen</h2>
          <ShortcutPreviewView preview={shortcutPreview} />
        </>
      )}

      {preview !== null && (
        <div className="panel">
          <h2>4. Apply</h2>
          <p>
            Download the plan first if you want it reviewed by someone else, or checked in
            Excel — it lists every row, including the ones shown truncated above.
          </p>
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() =>
                downloadCsv(
                  datedFilename(groupPreview ? 'group-plan' : 'shortcut-plan'),
                  groupPreview
                    ? groupPreviewToCsv(groupPreview)
                    : shortcutPreviewToCsv(shortcutPreview as ShortcutPreview),
                )
              }
            >
              Download this plan
            </button>
            {structure !== null && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  downloadText(
                    datedFilename('group-structure-preview').replace(/\.csv$/, '.txt'),
                    structureToText(structure),
                    'text/plain;charset=utf-8',
                  )
                }
              >
                Download the structure
              </button>
            )}
          </div>

          {needsClearAck && (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={clearsAcknowledged}
                onChange={(e) => setClearsAcknowledged(e.target.checked)}
                disabled={running || runSummary !== null}
              />
              I understand that {plural(shortcutPreview?.clears.length ?? 0, 'process')} will
              have every shortcut removed, and that this tool cannot put them back.
            </label>
          )}

          {preview.isNoOp ? (
            <p className="pending">
              There is nothing to apply — this file matches what your tenant already has.
            </p>
          ) : (
            <p className="pending">
              This writes to <code>{session.tenant}</code>. Leave this tab open until it
              finishes; if it is interrupted, come back and apply the same file again to
              pick up where it stopped.
            </p>
          )}

          <div className="row">
            <button type="button" onClick={() => void apply()} disabled={!canApply}>
              {running ? 'Applying…' : 'Apply this plan'}
            </button>
            {running && (
              <button
                type="button"
                className="secondary"
                onClick={() => abortRef.current?.abort()}
              >
                Stop
              </button>
            )}
          </div>
        </div>
      )}

      {progress !== null && runSummary === null && (
        <div className="panel">
          <h2>
            {progress.phase === 'groups' ? 'Creating groups' : 'Updating processes'} —{' '}
            {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
          </h2>
          <progress value={progress.done} max={Math.max(progress.total, 1)} />
          <p>{progress.label}</p>
        </div>
      )}

      {runSummary !== null && (
        <>
          <h2 className="section">What happened</h2>
          <RunResultView
            summary={runSummary}
            counts={summarise({ outcomes: runSummary.outcomes, groupPlan, shortcutPlan })}
            attention={needsAttention({ outcomes: runSummary.outcomes, groupPlan, shortcutPlan })}
            onDownload={downloadReport}
            onStartAgain={() => {
              resetResults();
              setFileName(null);
            }}
          />
        </>
      )}
    </main>
  );
}
