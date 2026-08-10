'use client';

/**
 * Presentational pieces of the preview.
 *
 * All the judgement lives in `lib/ui/preview.ts`, which is tested; these components
 * only lay out what it produced. The one rule they enforce themselves is the row cap:
 * a plan over a tenant this size can run to thousands of rows, and a page that tries
 * to render all of them stops being reviewable.
 */

import type { CsvIssue } from '@/lib/csv/groups.ts';
import type { ReportSummary } from '@/lib/exec/report.ts';
import { ACTION_RECOVERED, type Outcome, type RunSummary } from '@/lib/exec/runner.ts';
import type { OrphanGroup } from '@/lib/plan/orphans.ts';
import { audienceChanges, type VisibilityReport } from '@/lib/plan/visibility.ts';
import type { GroupPreview, ShortcutPreview, ShortcutPreviewRow } from '@/lib/ui/preview.ts';
import type { StructureNode, StructurePreview } from '@/lib/ui/structure.ts';

/** Rows rendered on screen before deferring to the downloadable CSV. */
export const MAX_ROWS = 200;

/** "1 process", "12 processes". Counts here are read by people, not logs. */
export function plural(count: number, one: string, many = `${one}es`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

export function IssueList({
  title,
  issues,
  tone,
}: {
  title: string;
  issues: readonly CsvIssue[];
  tone: 'error' | 'warning';
}) {
  if (issues.length === 0) return null;
  return (
    <div className={`panel ${tone === 'error' ? 'error' : 'warning'}`}>
      <h2>
        {title} ({issues.length})
      </h2>
      <ul className="issues">
        {issues.slice(0, MAX_ROWS).map((issue, i) => (
          <li key={`${issue.line}-${i}`}>
            {issue.line > 0 && <span className="line">Row {issue.line}</span>}
            {issue.message}
          </li>
        ))}
      </ul>
      {issues.length > MAX_ROWS && (
        <p>…and {issues.length - MAX_ROWS} more. Fix these first, then upload again.</p>
      )}
    </div>
  );
}

export function Counts({ items }: { items: Array<{ label: string; value: number; loud?: boolean }> }) {
  return (
    <div className="counts">
      {items.map((item) => (
        <div key={item.label} className={item.loud === true ? 'count loud' : 'count'}>
          <span className="value">{item.value.toLocaleString()}</span>
          <span className="label">{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function Truncated({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="truncated">
      Showing the first {shown.toLocaleString()} of {total.toLocaleString()}. Download the
      plan to review the rest.
    </p>
  );
}

// ------------------------------------------------------- group structure

function StructureBranch({ nodes }: { nodes: readonly StructureNode[] }) {
  return (
    <ul className="tree">
      {nodes.map((node) => (
        <li key={node.key} className={node.status === 'existing' ? '' : node.status}>
          <span className="name">{node.name}</span>
          {node.status === 'new' && <span className="tag new">new</span>}
          {node.status === 'moved' && <span className="tag moved">moved here</span>}
          {node.status === 'renamed' && <span className="tag renamed">renamed</span>}
          {node.isDocumentGroup && <span className="tag">documents only</span>}
          {node.children.length > 0 && <StructureBranch nodes={node.children} />}
          {node.hasHiddenChildren && (
            // Never draw a group as empty when we simply did not look inside it.
            <ul className="tree">
              <li className="hidden-children">existing subgroups, not shown</li>
            </ul>
          )}
        </li>
      ))}
    </ul>
  );
}

export function StructureView({ preview }: { preview: StructurePreview }) {
  return (
    <div className="panel">
      <h2>Structure afterwards</h2>
      <p>
        Your file&rsquo;s branches, with everything already in place around them. New and
        moved groups are added at the end of their level — this run never reorders
        anything. A moved group is drawn only at its destination; its subgroups go with it.
      </p>
      <StructureBranch nodes={preview.roots} />
    </div>
  );
}

// ------------------------------------------------------------ group plan

/**
 * Who can see the groups being moved, before and after.
 *
 * Permissions are inherited down the tree, so this is the consequence of a move that a
 * structure diagram cannot show: the shape looks tidier and the readership silently
 * changed. The numbers are Process Manager's own — it runs the same check after every
 * move made through its UI.
 */
function VisibilityView({ report }: { report: VisibilityReport }) {
  if (report.moves.length === 0) return null;

  const changed = audienceChanges(report.moves);
  const unknown = report.moves.filter((m) => m.before === null || m.after === null);

  return (
    <div className={changed.length > 0 ? 'panel warning' : 'panel'}>
      <h2>Who can see these groups</h2>
      {report.unavailable !== null ? (
        <p>
          The viewer counts could not be read ({report.unavailable}), so the effect of
          these moves on visibility is not shown. The plan itself is unaffected — but
          permissions are inherited down the tree, so check the destinations yourself
          before applying.
        </p>
      ) : changed.length === 0 ? (
        <p>
          No move changes the audience: each group lands somewhere with the same viewers
          and roles as where it sits now.
          {unknown.length > 0 &&
            ` ${unknown.length} could not be compared, most likely because the destination does not exist yet.`}
        </p>
      ) : (
        <>
          <p>
            {plural(changed.length, 'group')} land somewhere with a different audience.
            Everything inside them — subgroups and processes alike — follows the
            destination&rsquo;s permissions, not the ones it has today.
          </p>
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Viewers now</th>
                <th>Viewers after</th>
              </tr>
            </thead>
            <tbody>
              {changed.slice(0, MAX_ROWS).map((row) => (
                <tr key={row.uniqueId}>
                  <td>{row.name}</td>
                  <td className="muted">{describeAudience(row.before)}</td>
                  <td>{describeAudience(row.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Truncated shown={MAX_ROWS} total={changed.length} />
        </>
      )}
    </div>
  );
}

function describeAudience(count: { users: number; roles: number } | null): string {
  if (count === null) return 'not known';
  return `${plural(count.users, 'user')}, ${plural(count.roles, 'role')}`;
}

export function GroupPreviewView({
  preview,
  structure,
  orphans,
  visibility,
}: {
  preview: GroupPreview;
  structure: StructurePreview | null;
  orphans: readonly OrphanGroup[];
  visibility: VisibilityReport | null;
}) {
  return (
    <>
      <Counts
        items={[
          { label: 'groups to create', value: preview.creates.length, loud: true },
          // Loud as well: a move carries a group's processes and permissions with it,
          // which is a bigger deal than adding an empty group.
          { label: 'to move', value: preview.moves.length, loud: preview.moves.length > 0 },
          { label: 'to rename', value: preview.renames.length },
          { label: 'already exist', value: preview.existingCount },
          { label: 'blocked', value: preview.blocked.length },
        ]}
      />

      {orphans.length > 0 && (
        <div className="panel warning">
          <h2>{plural(orphans.length, 'unnamed group')} already in your tenant</h2>
          <p>
            Creating a group happens in two steps, and Process Manager is known to drop
            the second one when many groups are made at once — leaving a group called
            &ldquo;New Group&rdquo;. This tool matches groups by name, so it cannot see
            these, and any file naming the same group will create a fresh one beside the
            half-made one.
          </p>
          <p>
            Rename or delete these in Process Manager first, unless you are happy for the
            groups below to be created alongside them.
          </p>
          <ul className="issues">
            {orphans.slice(0, MAX_ROWS).map((orphan) => (
              <li key={orphan.uniqueId}>{orphan.display}</li>
            ))}
          </ul>
        </div>
      )}

      {structure !== null && <StructureView preview={structure} />}

      {preview.isNoOp && (
        <div className="panel">
          <h2>Nothing to do</h2>
          <p>
            Every group in the file already exists, with the name and in the place the
            file puts it. Applying this would change nothing — which is what you want to
            see when re-running a file you have already applied.
          </p>
        </div>
      )}

      {preview.moves.length > 0 && (
        <div className="panel warning">
          <h2>Groups to move ({preview.moves.length})</h2>
          <p>
            Each group keeps its id, so its processes, shortcuts, and stakeholders travel
            with it — nothing is copied and nothing is republished. Its subgroups move
            too. Because permissions are inherited down the tree, moving a group can
            change who can see everything inside it.
          </p>
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>From</th>
                <th>To</th>
                <th>Row</th>
              </tr>
            </thead>
            <tbody>
              {preview.moves.slice(0, MAX_ROWS).map((row) => (
                <tr key={row.uniqueId}>
                  <td>{row.name}</td>
                  <td className="muted">{row.fromDisplay}</td>
                  <td>
                    {row.toDisplay}
                    {row.intoNewParent && <span className="muted"> (new parent)</span>}
                  </td>
                  <td className="muted">{row.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Truncated shown={MAX_ROWS} total={preview.moves.length} />
        </div>
      )}

      {visibility !== null && <VisibilityView report={visibility} />}

      {preview.renames.length > 0 && (
        <div className="panel">
          <h2>Groups to rename ({preview.renames.length})</h2>
          <p>
            The group itself is untouched — only its name changes. Anyone who has
            bookmarked it by name, or written it into a document, will see the new one.
          </p>
          <table>
            <thead>
              <tr>
                <th>Now</th>
                <th>Becomes</th>
                <th>Row</th>
              </tr>
            </thead>
            <tbody>
              {preview.renames.slice(0, MAX_ROWS).map((row) => (
                <tr key={row.uniqueId}>
                  <td className="muted">{row.fromDisplay}</td>
                  <td>{row.to}</td>
                  <td className="muted">{row.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Truncated shown={MAX_ROWS} total={preview.renames.length} />
        </div>
      )}

      {preview.creates.length > 0 && (
        <div className="panel">
          <h2>Groups to create</h2>
          <p>In this order, so each group&rsquo;s parent exists before it does.</p>
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Created</th>
                <th>Row</th>
              </tr>
            </thead>
            <tbody>
              {preview.creates.slice(0, MAX_ROWS).map((row) => (
                <tr key={row.seq}>
                  <td>{row.display}</td>
                  <td className="muted">{row.parentLabel}</td>
                  <td className="muted">{row.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Truncated shown={MAX_ROWS} total={preview.creates.length} />
        </div>
      )}

      {preview.blocked.length > 0 && (
        <div className="panel error">
          <h2>Blocked ({preview.blocked.length})</h2>
          <p>These rows will be skipped. Everything else can still be applied.</p>
          <ul className="issues">
            {preview.blocked.slice(0, MAX_ROWS).map((issue, i) => (
              <li key={`${issue.line}-${i}`}>
                <span className="line">Row {issue.line}</span>
                {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

// --------------------------------------------------------- shortcut plan

function Diff({ row }: { row: ShortcutPreviewRow }) {
  return (
    <div className="diff">
      {row.diff.added.map((add) => (
        <div key={`+${add.display}`} className="added">
          + {add.display}
          {add.isNewGroup && <span className="tag">new group</span>}
        </div>
      ))}
      {row.diff.removed.map((name) => (
        <div key={`-${name}`} className="removed">
          − {name}
        </div>
      ))}
      {row.diff.kept.length > 0 && (
        <div className="kept">unchanged: {row.diff.kept.join(', ')}</div>
      )}
      {row.diff.added.length === 0 && row.diff.removed.length === 0 && (
        <div className="kept">no shortcuts left</div>
      )}
    </div>
  );
}

function ChangeTable({ rows }: { rows: readonly ShortcutPreviewRow[] }) {
  return (
    <>
      <table>
        <thead>
          <tr>
            <th>Process</th>
            <th>Change</th>
            <th>Version</th>
            <th>Row</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, MAX_ROWS).map((row) => (
            <tr key={row.processUniqueId}>
              <td>
                {row.processName}
                <div className="muted small">{row.effect}</div>
              </td>
              <td>
                <Diff row={row} />
              </td>
              <td className="muted nowrap">
                {row.expectedVersion === null ? (
                  row.version
                ) : (
                  <>
                    {row.version} → <strong>{row.expectedVersion}</strong>
                  </>
                )}
              </td>
              <td className="muted">{row.line}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Truncated shown={MAX_ROWS} total={rows.length} />
    </>
  );
}

export function ShortcutPreviewView({ preview }: { preview: ShortcutPreview }) {
  return (
    <>
      <Counts
        items={[
          { label: 'processes to update', value: preview.counts.updates, loud: true },
          { label: 'to clear', value: preview.counts.clears, loud: preview.counts.clears > 0 },
          { label: 'republished', value: preview.counts.publishes, loud: true },
          { label: 'saved as drafts', value: preview.counts.drafts },
          { label: 'unchanged', value: preview.counts.unchanged },
          { label: 'blocked', value: preview.counts.blocked },
        ]}
      />

      {preview.isNoOp && (
        <div className="panel">
          <h2>Nothing to do</h2>
          <p>
            Every process already has exactly the shortcuts in your file. Nothing would be
            written, and no version would change.
          </p>
        </div>
      )}

      {preview.counts.publishes > 0 && (
        <div className="panel warning">
          <h2>{plural(preview.counts.publishes, 'process')} will be republished</h2>
          <p>
            Each gets a new published major version, visible to everyone who reads it.
            Change notifications are suppressed, so stakeholders will not be emailed.
            About {preview.writes.toLocaleString()} requests to Process Manager in total.
          </p>
        </div>
      )}

      {preview.updates.length > 0 && (
        <div className="panel">
          <h2>Updates ({preview.updates.length.toLocaleString()})</h2>
          <ChangeTable rows={preview.updates} />
        </div>
      )}

      {preview.clears.length > 0 && (
        <div className="panel warning">
          <h2>Removing all shortcuts ({preview.clears.length.toLocaleString()})</h2>
          <p>
            These rows said CLEAR. Every shortcut is removed; the process stays in its own
            group. This tool cannot put them back.
          </p>
          <ChangeTable rows={preview.clears} />
        </div>
      )}

      <IssueList title="Warnings" issues={preview.warnings} tone="warning" />

      {preview.blocked.length > 0 && (
        <div className="panel error">
          <h2>Skipped ({preview.blocked.length.toLocaleString()})</h2>
          <p>These processes will not be touched. Everything else can still be applied.</p>
          <table>
            <thead>
              <tr>
                <th>Process</th>
                <th>Reason</th>
                <th>Row</th>
              </tr>
            </thead>
            <tbody>
              {preview.blocked.slice(0, MAX_ROWS).map((row, i) => (
                <tr key={`${row.processUniqueId ?? row.processName}-${i}`}>
                  <td>{row.processName}</td>
                  <td className="muted">{row.reason}</td>
                  <td className="muted">{row.line}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Truncated shown={MAX_ROWS} total={preview.blocked.length} />
        </div>
      )}
    </>
  );
}

// -------------------------------------------------------------- the run

/**
 * What happened, once it has happened.
 *
 * Leads with the report download rather than the counts. A bulk run's real output is
 * a file someone keeps — the on-screen summary is for deciding whether to worry, and
 * everything worth worrying about is listed rather than counted.
 */
export function RunResultView({
  summary,
  counts,
  attention,
  onDownload,
  onStartAgain,
}: {
  summary: RunSummary;
  counts: ReportSummary;
  attention: readonly Outcome[];
  onDownload: () => void;
  onStartAgain: () => void;
}) {
  const recoveries = summary.outcomes.filter((o) => o.action === ACTION_RECOVERED);

  return (
    <>
      {summary.stopped && (
        <div className="panel warning">
          <h2>Stopped before the end</h2>
          <p>{summary.stoppedReason}</p>
        </div>
      )}

      <Counts
        items={[
          { label: 'applied', value: counts.ok, loud: true },
          { label: 'skipped', value: counts.skipped, loud: counts.skipped > 0 },
          { label: 'failed', value: counts.failed, loud: counts.failed > 0 },
          { label: 'blocked before the run', value: counts.blocked },
        ]}
      />

      <div className="panel">
        <h2>Keep the report</h2>
        <p>
          Every row this file touched, including the ones that were skipped and why. It is
          generated here in your browser and never sent anywhere.
        </p>
        <div className="row">
          <button type="button" onClick={onDownload}>
            Download the report
          </button>
          <button type="button" className="secondary" onClick={onStartAgain}>
            Start again
          </button>
        </div>
      </div>

      {recoveries.length > 0 && (
        <div className="panel warning">
          <h2>{plural(recoveries.length, 'group')} needed repairing</h2>
          <p>
            Process Manager reported these as failed, or reported them renamed when they
            were not. They were repaired rather than created twice, so your tree is
            correct — but this is the behaviour that leaves &ldquo;New Group&rdquo;
            entries behind, so it is worth knowing it happened here.
          </p>
          <ul className="issues">
            {recoveries.slice(0, MAX_ROWS).map((row, i) => (
              <li key={`${row.targetId ?? row.target}-${i}`}>
                <strong>{row.target}</strong> — {row.detail}
              </li>
            ))}
          </ul>
        </div>
      )}

      {attention.length > 0 ? (
        <div className={counts.failed > 0 ? 'panel error' : 'panel warning'}>
          <h2>Needs a look ({attention.length.toLocaleString()})</h2>
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Result</th>
                <th>Detail</th>
                <th>Row</th>
              </tr>
            </thead>
            <tbody>
              {attention.slice(0, MAX_ROWS).map((row, i) => (
                <tr key={`${row.targetId ?? row.target}-${i}`}>
                  <td>{row.target}</td>
                  <td className="nowrap">{row.result}</td>
                  <td className="muted">{row.detail}</td>
                  <td className="muted">{row.line ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {attention.length > MAX_ROWS && (
            <p className="truncated">
              Showing the first {MAX_ROWS} of {attention.length.toLocaleString()}. The report
              has the rest.
            </p>
          )}
        </div>
      ) : (
        <div className="panel">
          <h2>Everything applied</h2>
          <p>Nothing was skipped, blocked, or failed.</p>
        </div>
      )}
    </>
  );
}
