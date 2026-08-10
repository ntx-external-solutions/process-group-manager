'use client';

/**
 * Choose a task, upload a file, see exactly what would happen.
 *
 * The whole screen is a dry run: it reads Process Manager and writes nothing. That is
 * not a temporary state of the code — PLAN.md §8 makes "nothing writes before the
 * preview is shown" a rule, so applying will be a separate, explicit step behind this
 * one rather than a shortcut around it.
 *
 * Orchestration lives in the browser because there is no data backend and no server
 * job to hold a run: the tab drives every request through the proxy, one at a time.
 */

import { useEffect, useState } from 'react';

import { classifyCsv } from '@/lib/csv/detect.ts';
import { parseGroupCsv, type CsvIssue } from '@/lib/csv/groups.ts';
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
import { GroupPreviewView, IssueList, plural, ShortcutPreviewView } from './parts.tsx';

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

  useEffect(() => {
    void currentSession().then((info) => {
      setSession(info);
      setCheckingSession(false);
    });
  }, []);

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
    setClearsAcknowledged(false);
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

  return (
    <main>
      <h1>Plan a change</h1>
      <p className="lede">
        Signed in as {session.username} — tenant <code>{session.tenant}</code>.{' '}
        <strong>Nothing on this page changes anything</strong> in Process Manager.
      </p>

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
              />
              I understand that {plural(shortcutPreview?.clears.length ?? 0, 'process')} will
              have every shortcut removed, and that this tool cannot put them back.
            </label>
          )}

          <p className="pending">
            Applying is not built yet. This release plans and previews only — no version of
            this tool has ever written to your tenant.
          </p>
          <button type="button" disabled>
            Apply this plan
          </button>
        </div>
      )}
    </main>
  );
}
