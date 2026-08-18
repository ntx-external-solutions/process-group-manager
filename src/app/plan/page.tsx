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
import { needsDirectory } from '@/lib/csv/champions.ts';
import { hasChampionColumns } from '@/lib/csv/layout.ts';
import { Journal, loadJournal, sessionJournalStore } from '@/lib/exec/journal.ts';
import { needsAttention, reportToCsv, summarise, type ReportSummary } from '@/lib/exec/report.ts';
import { runPlan, type Outcome, type RunProgress, type RunSummary } from '@/lib/exec/runner.ts';
import type { ChampionPlan } from '@/lib/plan/championPlan.ts';
import type { GroupPlan } from '@/lib/plan/groupPlan.ts';
import { findOrphanGroups, type OrphanGroup } from '@/lib/plan/orphans.ts';
import { revalidateGroupPlan, type StaleFinding } from '@/lib/plan/revalidate.ts';
import type { PublishChoice, ShortcutPlan } from '@/lib/plan/shortcutPlan.ts';
import { parseProcessListCsv, toShortcutCsv } from '@/lib/csv/processList.ts';
import { parseShortcutCsv } from '@/lib/csv/shortcuts.ts';
import { groupTemplate, groupExport, shortcutTemplate } from '@/lib/csv/template.ts';
import { allGroups } from '@/lib/plan/tree.ts';
import {
  buildChampionPlan,
  buildGroupPlan,
  buildShortcutPlan,
  describeMoveVisibility,
  indexGroupsById,
  type ShortcutPlanResult,
} from '@/lib/plan/orchestrate.ts';
import type { VisibilityReport } from '@/lib/plan/visibility.ts';
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
  buildChampionPreview,
  buildGroupPreview,
  buildShortcutPreview,
  championPreviewToCsv,
  groupPreviewToCsv,
  requiresClearConfirmation,
  shortcutPreviewToCsv,
  type ChampionPreview,
  type GroupPreview,
  type ShortcutPreview,
} from '@/lib/ui/preview.ts';
import { cachedTreeAt, describeAge, invalidateTree, wholeTree } from '@/lib/ui/treeCache.ts';
import {
  buildStructurePreview,
  structureToText,
  type StructurePreview,
} from '@/lib/ui/structure.ts';
import {
  ChampionPreviewView,
  GroupPreviewView,
  IssueList,
  plural,
  PublishChoiceView,
  RunResultView,
  ScimKeyPrompt,
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
  const [championPreview, setChampionPreview] = useState<ChampionPreview | null>(null);
  const [clearsAcknowledged, setClearsAcknowledged] = useState(false);

  // The SCIM key lives here and nowhere else: not in the session cookie, not in
  // sessionStorage. A file that needs one is parked until it is given.
  const [scimKey, setScimKey] = useState<string | null>(null);
  const [awaitingKey, setAwaitingKey] = useState<string | null>(null);

  // When the held tree was read, and what re-checking it just before Apply turned up.
  const [treeReadAt, setTreeReadAt] = useState<number | null>(null);
  const [stale, setStale] = useState<StaleFinding[]>([]);

  // Whether this run publishes anything. Re-planning is free once the reads are done,
  // so the choice re-derives the plan rather than being handed to the runner: the
  // operator approves the plan their answer produced, not another one.
  const [publish, setPublish] = useState<PublishChoice>('save-only');
  const replanRef = useRef<ShortcutPlanResult['replan'] | null>(null);

  // The previews are for reading; these are what actually gets executed. Keeping both
  // from the same planning pass is what guarantees the run matches what was approved.
  const [orphans, setOrphans] = useState<OrphanGroup[]>([]);
  const [visibility, setVisibility] = useState<VisibilityReport | null>(null);
  const [groupPlan, setGroupPlan] = useState<GroupPlan | null>(null);
  const [championPlan, setChampionPlan] = useState<ChampionPlan | null>(null);
  const [shortcutPlan, setShortcutPlan] = useState<ShortcutPlan | null>(null);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<RunProgress | null>(null);
  const [runSummary, setRunSummary] = useState<RunSummary | null>(null);
  const [unfinished, setUnfinished] = useState<Journal | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    // Read from location rather than useSearchParams, which would force this page
    // behind a Suspense boundary for no benefit.
    const wanted = new URLSearchParams(window.location.search).get('task');
    if (wanted === 'groups' || wanted === 'shortcuts') setTask(wanted);

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
    setOrphans([]);
    setVisibility(null);
    setShortcutPreview(null);
    setChampionPreview(null);
    setGroupPlan(null);
    setChampionPlan(null);
    setShortcutPlan(null);
    setClearsAcknowledged(false);
    setPublish('save-only');
    replanRef.current = null;
    setRunSummary(null);
    setProgress(null);
    setAwaitingKey(null);
    setStale([]);
  }

  function chooseTask(next: Task) {
    resetResults();
    setFileName(null);
    setTask(next);
  }

  function handleFailure(cause: unknown) {
    if (cause instanceof PmRequestError) {
      setError([cause.message, cause.detail].filter(Boolean).join(': '));
      // Only an actually-rejected session sends them back to sign in.
      if (cause.signedOut) setSession(null);
      return;
    }
    setError(cause instanceof Error ? cause.message : 'Something went wrong.');
  }

  // ------------------------------------------------------------ downloads

  /**
   * The whole tree, from the few-minute cache when it is warm.
   *
   * Every caller here is building something to *look* at. Writing is a separate
   * question, answered against the tenant at Apply time — see `apply`.
   */
  async function readWholeTree(label: string, force = false) {
    if (!session) throw new Error('Not signed in.');
    const tree = await wholeTree(browserGateway(), session.tenant, {
      force,
      onProgress: (event) => setBusy(`${label} ${event.done} groups`),
    });
    setTreeReadAt(cachedTreeAt(session.tenant));
    return tree;
  }

  async function refreshTree() {
    setBusy('Reading the group tree…');
    resetResults();
    try {
      const tree = await readWholeTree('Reading the group tree…', true);
      setNote(`Read ${allGroups(tree).length.toLocaleString()} groups. Upload your file again.`);
    } catch (cause) {
      handleFailure(cause);
    } finally {
      setBusy(null);
    }
  }

  async function downloadCurrentStructure() {
    setBusy('Reading the group tree…');
    resetResults();
    try {
      const tree = await readWholeTree('Reading the group tree…');
      const groups = allGroups(tree);
      downloadCsv(datedFilename('group-hierarchy'), groupExport(groups));
      setNote(
        task === 'shortcuts'
          ? `Downloaded ${groups.length.toLocaleString()} groups with their ids. Copy the ` +
            `Group Unique Id of each group you want a shortcut in.`
          : `Downloaded ${groups.length.toLocaleString()} groups, one level per column. ` +
            `Keep the Group Unique Id on rows you are keeping. It ties a row to that ` +
            `exact group.`,
      );
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
        if (kind === 'shortcut-file' || kind === 'legacy-shortcut-file' || kind === 'process-list') {
          setError(
            'That is a shortcuts file. Pick "Process shortcuts" above, or upload a file ' +
              'with one group per row.',
          );
          return;
        }
        await planGroups(text);
        return;
      }

      if (kind === 'group-file') {
        setError(
          'That is a group-structure file. Pick "Group structure" above, or upload a ' +
            'file with a Group Unique Id column on every shortcut row.',
        );
        return;
      }
      if (kind === 'legacy-shortcut-file') {
        setError(
          'This file uses the old Shortcut 1, Shortcut 2 columns, which named groups by ' +
            'path. Group names repeat, so paths pointed at the wrong group. Use one row ' +
            'per shortcut with a Group Unique Id instead. The template below shows the ' +
            'format, and the group hierarchy download has the ids.',
        );
        return;
      }
      if (kind === 'process-list') {
        // They uploaded Process Manager's export. It carries no group ids, so convert it
        // into the worksheet that can hold them and hand it back.
        await convertProcessList(text);
        return;
      }
      if (kind === 'unknown') {
        setError(
          'This file has no Group Unique Id column and is not a Process List export, so ' +
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

  async function planGroups(text: string, key: string | null = scimKey) {
    const parsed = parseGroupCsv(text);
    setIssues({ errors: parsed.errors, warnings: parsed.warnings });
    if (parsed.errors.length > 0) return;

    // Champions are named by logon and assigned by user id, and only SCIM bridges the
    // two. Park the file rather than planning half of it: a preview that silently
    // omitted the champion columns would be approved as though it covered them.
    //
    // Asked on the *contents*, not on the columns. Every generated file carries the
    // columns now, so asking on those would demand a key to re-upload an untouched
    // export — and `CLEAR` names nobody, so removing a champion needs no key either.
    const wantsChampions = hasChampionColumns(parsed.layout);
    if (wantsChampions && needsDirectory(parsed.rows) && key === null) {
      setAwaitingKey(text);
      return;
    }
    setAwaitingKey(null);

    setBusy('Checking which groups already exist…');
    const gateway = browserGateway();

    // A file carrying ids needs the whole tree either way, so read it through the cache
    // rather than beside it — that is what makes fixing a typo and re-uploading cheap.
    // A file with no ids resolves a handful of levels on demand, which is cheaper than
    // reading the tenant to fill a cache, so it only borrows one that is already warm.
    const needsWholeTree =
      parsed.rows.some((row) => row.uniqueId !== null) ||
      (session !== null && cachedTreeAt(session.tenant) !== null);
    const cached = needsWholeTree ? await readWholeTree('Reading the group tree…') : undefined;

    const { plan, tree } = await buildGroupPlan(
      gateway,
      parsed.rows,
      (event) => setBusy(`Checking which groups already exist… ${event.done} levels`),
      { wholeTree: cached },
    );
    setGroupPreview(buildGroupPreview(plan));
    setGroupPlan(plan);

    if (wantsChampions) {
      setBusy('Reading the users and the current champions…');
      const champions = await buildChampionPlan(gateway, parsed.rows, plan, {
        scimApiKey: needsDirectory(parsed.rows) ? key : null,
        probeGroupUniqueId: tree.roots[0]?.uniqueId ?? null,
        onProgress: (event) =>
          setBusy(`Reading the current champions… ${event.done} of ${event.total ?? '?'}`),
      });
      setChampionPreview(buildChampionPreview(champions.plan));
      setChampionPlan(champions.plan);
      setUnreadable(
        champions.unreadable.map((f) => ({
          line: 0,
          message: `Could not read the current champions of group ${f.uniqueId}: ${f.message}. Its champion is still set, but the plan cannot show who it replaces.`,
        })),
      );
    }

    if (plan.moves.length > 0) {
      // Permissions are inherited down the tree, so a move changes who can see
      // everything inside the group. Advisory: a failure here leaves the plan alone.
      setBusy('Checking who can see the groups being moved…');
      setVisibility(await describeMoveVisibility(browserGateway(), tree, plan));
    }

    // Half-made groups from an earlier interrupted attempt. They are invisible to
    // name matching, so without this the file would create duplicates beside them.
    setOrphans(findOrphanGroups(tree));
    // The tree is what makes "what will this look like" answerable; the plan alone
    // only knows the paths, not what already sits beside them.
    setStructure(buildStructurePreview(tree, plan));
  }

  async function planShortcuts(text: string) {
    const parsed = parseShortcutCsv(text);
    setIssues({ errors: parsed.errors, warnings: parsed.warnings });
    if (parsed.errors.length > 0) return;

    const gateway = browserGateway();

    // The file names groups by id, so there is no path to walk and nothing to guess at.
    // The whole tree is read once and turned into a lookup table, which also gives every
    // group a full path to show in the preview.
    setBusy('Reading the group tree…');
    const tree = await readWholeTree('Reading the group tree…');
    const groups = indexGroupsById(tree);

    setBusy('Reading the processes…');
    // Not the `publish` state: resetResults has only just scheduled it back to the
    // default, and reading it here would plan against the previous file's answer.
    const result = await buildShortcutPlan(gateway, parsed.processes, groups, {
      publish: 'save-only',
      onProgress: (event) =>
        setBusy(`Reading the processes… ${event.done} of ${event.total ?? '?'}`),
    });

    setUnreadable(
      result.unreadable.map((f) => ({
        line: f.line,
        message: `Could not read process ${f.processUniqueId}: ${f.message}`,
      })),
    );
    replanRef.current = result.replan;
    setShortcutPreview(buildShortcutPreview(result.plan));
    setShortcutPlan(result.plan);
  }

  /** Answer the publish question, and re-derive the plan from the same reads. */
  function choosePublish(next: PublishChoice) {
    setPublish(next);
    const replan = replanRef.current;
    if (!replan) return;
    const plan = replan({ publish: next });
    setShortcutPreview(buildShortcutPreview(plan));
    setShortcutPlan(plan);
    setClearsAcknowledged(false);
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
    setNote(
      `That was Process Manager's Process List export, so we turned it into a worksheet: ` +
        `${result.processes.length.toLocaleString()} processes, one row each, with their ` +
        `current shortcuts listed for reference. Fill in a Group Unique Id on each row ` +
        `you want to change, add a row per extra shortcut, then upload it here.`,
    );
  }

  // ------------------------------------------------------------- applying

  async function apply() {
    if (!session || running) return;

    setRunning(true);
    setError(null);
    setRunSummary(null);
    setProgress(null);
    setStale([]);

    // Continue an unfinished run rather than starting a fresh journal: steps that
    // already completed must not be attempted twice.
    const journal =
      unfinished ??
      Journal.start(`run-${Date.now()}`, session.tenant, Date.now(), sessionJournalStore());

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // The tree the plan was built from may be minutes old, and the executor has no
      // existence check of its own — a group somebody else added since would be created
      // a second time. This reads only the levels the plan touches.
      if (groupPlan) {
        setProgress({
          phase: 'groups',
          done: 0,
          total: 1,
          label: 'Checking nothing has changed since the preview…',
        });
        const findings = await revalidateGroupPlan(browserGateway(), groupPlan);
        if (findings.length > 0) {
          // The tenant has moved on, so the next upload must not plan from the copy that
          // described the old one.
          invalidateTree();
          setTreeReadAt(null);
          setStale(findings);
          setProgress(null);
          return;
        }
      }

      const summary = await runPlan(
        browserExecGateway(),
        journal,
        { groupPlan, championPlan, shortcutPlan },
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
      // Whatever happened, the held tree no longer describes the tenant.
      invalidateTree();
      setTreeReadAt(null);
      setRunning(false);
      abortRef.current = null;
    }
  }

  function downloadReport() {
    downloadCsv(
      datedFilename(groupPlan ? 'group-run-report' : 'shortcut-run-report'),
      reportToCsv({ outcomes: runSummary?.outcomes ?? [], groupPlan, championPlan, shortcutPlan }),
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
            <a href="/">Sign in</a> and come back. Your session is held in a cookie and
            nothing is stored on the server.
          </p>
        </div>
      </main>
    );
  }

  const preview = groupPreview ?? shortcutPreview;
  const needsClearAck = shortcutPreview !== null && requiresClearConfirmation(shortcutPreview);
  // A file whose groups all exist can still be worth applying — that is exactly what a
  // file that only sets champions looks like.
  const isNoOp = (preview?.isNoOp ?? true) && (championPreview?.isNoOp ?? true);
  const canApply =
    preview !== null &&
    !isNoOp &&
    !running &&
    runSummary === null &&
    (!needsClearAck || clearsAcknowledged);

  return (
    <main>
      <p className="crumb">
        <a href="/">← Your process groups</a>
      </p>
      <h1>Plan a change</h1>
      <p className="lede">
        Signed in as {session.username} on tenant <code>{session.tenant}</code>. Nothing is
        written until you press Apply.
      </p>

      {unfinished !== null && runSummary === null && (
        <div className="panel warning">
          <h2>A previous run in this tab did not finish</h2>
          <ul className="checklist">
            <li>Upload the same file again and apply it.</li>
            <li>Anything that already completed is skipped, not repeated.</li>
            <li>
              Discard the run instead to start clean. Steps that already ran will then be
              attempted a second time.
            </li>
          </ul>
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
          <p>One group per row, one level per column.</p>
          <ul className="checklist">
            <li>
              Put the full path on every row, across <code>Level 1</code>,{' '}
              <code>Level 2</code>, and so on. Do not leave parent cells blank.
            </li>
            <li>
              A single <code>Group Path</code> column with levels separated by{' '}
              <code>|</code> also works.
            </li>
            <li>
              Keep the <code>Group Unique Id</code> on rows for groups that already exist.
              Leave it blank on rows you are adding.
            </li>
            <li>
              On a row with an id, the name and level columns are the state you want.
              Change the last name to rename the group. Move it to different columns to
              reparent it. It keeps its id, so its processes and permissions go with it.
            </li>
            <li>
              Nothing is ever deleted. A group missing from your file is left alone.
              Deleting a row does not delete a group.
            </li>
            <li>
              Add a <code>Champion</code> column to set a group&rsquo;s champion by logon,
              and a <code>Regional Champions</code> column for{' '}
              <code>Region: logon</code> pairs separated by <code>;</code>. Both work on
              groups you are adding and on ones that already exist.
            </li>
            <li>
              A blank champion cell leaves that group&rsquo;s champions alone. Write{' '}
              <code>CLEAR</code> to remove them. Being a champion grants the right to
              restructure the group, so the preview lists every change.
            </li>
          </ul>
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
            One row per shortcut. Groups are named by id, never by name, because group
            names repeat and a name picks the wrong group.
          </p>
          <ul className="checklist">
            <li>
              Download the group hierarchy. It lists every group with its{' '}
              <code>Group Unique Id</code>.
            </li>
            <li>
              Export the Process List report from Process Manager and upload it below. We
              turn it into a worksheet with one row per process and its id filled in.
            </li>
            <li>
              Paste the <code>Group Unique Id</code> of the group you want a shortcut in.
              Add a row per extra shortcut: three shortcuts means three rows with the same{' '}
              <code>Process Unique Id</code>. The process is still written once.
            </li>
            <li>
              Leave <code>Action</code> blank or set it to <code>Add</code> to add a
              shortcut. Set it to <code>Remove</code> to take one away.
            </li>
            <li>
              Shortcuts you do not list are left alone. To strip a process back to none,
              put <code>CLEAR</code> in <code>Group Unique Id</code>.
            </li>
          </ul>
          <div className="row">
            <button
              type="button"
              className="secondary"
              onClick={() => void downloadCurrentStructure()}
              disabled={working}
            >
              Download group hierarchy
            </button>
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

      {treeReadAt !== null && (
        <p className="crumb">
          Your group structure was read {describeAge(treeReadAt)} and is being reused.{' '}
          <button
            type="button"
            className="link"
            onClick={() => void refreshTree()}
            disabled={working || running}
          >
            Read it again
          </button>
          {' '}if somebody else has been changing groups. It is re-checked before anything
          is written either way.
        </p>
      )}

      {task !== null && (
        <div className="panel">
          <h2>3. Upload your file</h2>
          <p>
            {task === 'shortcuts'
              ? 'Your shortcuts file, or a Process List export to convert.'
              : 'A CSV with one group per row.'}
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

      {awaitingKey !== null && (
        <ScimKeyPrompt
          fileName={fileName}
          busy={working}
          onSubmit={(key) => {
            setScimKey(key);
            setBusy('Reading the file…');
            void planGroups(awaitingKey, key)
              .catch(handleFailure)
              .finally(() => setBusy(null));
          }}
        />
      )}

      {stale.length > 0 && (
        <div className="panel error">
          <h2>Your tenant changed while this was on screen</h2>
          <p>
            Nothing was written. The preview above describes a structure that no longer
            matches Process Manager, so applying it could duplicate a group rather than
            create one. Upload the same file again to plan against what is there now.
          </p>
          <ul className="issues">
            {stale.map((finding, i) => (
              <li key={`${finding.line}-${i}`}>
                {finding.line !== null && <span className="line">Row {finding.line}</span>}
                {finding.message}
              </li>
            ))}
          </ul>
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
          <GroupPreviewView
            preview={groupPreview}
            structure={structure}
            orphans={orphans}
            visibility={visibility}
          />
        </>
      )}

      {championPreview !== null && (
        <>
          <h2 className="section">Champions</h2>
          <ChampionPreviewView preview={championPreview} />
        </>
      )}

      {shortcutPreview !== null && (
        <>
          <h2 className="section">What would happen</h2>
          <PublishChoiceView
            preview={shortcutPreview}
            value={publish}
            onChange={choosePublish}
            disabled={running || runSummary !== null}
          />
          <ShortcutPreviewView preview={shortcutPreview} />
        </>
      )}

      {preview !== null && (
        <div className="panel">
          <h2>4. Apply</h2>
          <p>
            Download the plan first to review it in Excel or send it to someone else. It
            lists every row, including any hidden by the row limit above.
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
            {championPreview !== null && !championPreview.isNoOp && (
              <button
                type="button"
                className="secondary"
                onClick={() =>
                  downloadCsv(datedFilename('champion-plan'), championPreviewToCsv(championPreview))
                }
              >
                Download the champion changes
              </button>
            )}
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

          {isNoOp ? (
            <p className="pending">
              Nothing to apply. This file matches what your tenant already has.
            </p>
          ) : (
            <p className="pending">
              This writes to <code>{session.tenant}</code>. Leave the tab open until it
              finishes. If it is interrupted, apply the same file again to pick up where it
              stopped.
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
            {progress.phase === 'groups'
              ? 'Creating groups'
              : progress.phase === 'champions'
                ? 'Setting champions'
                : 'Updating processes'}
            : {progress.done.toLocaleString()} of {progress.total.toLocaleString()}
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
            counts={summarise({ outcomes: runSummary.outcomes, groupPlan, championPlan, shortcutPlan })}
            attention={needsAttention({
              outcomes: runSummary.outcomes,
              groupPlan,
              championPlan,
              shortcutPlan,
            })}
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
