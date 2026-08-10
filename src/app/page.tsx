/**
 * Landing page.
 *
 * Says plainly what the tool can and cannot do today. Everything shipped so far reads;
 * nothing writes. That claim is worth stating on the front page while it is still true,
 * because it stops being true the moment the executor lands.
 */
export default function Home() {
  return (
    <main>
      <h1>Process Group Manager</h1>
      <p className="lede">
        Bulk group-structure and shortcut management for Nintex Process Manager.
      </p>

      <div className="panel">
        <h2>Plan a change</h2>
        <p>
          <a href="/signin">Sign in</a>, then <a href="/plan">upload a CSV</a> to see
          exactly what would change. Nothing is applied — this release reads your tenant
          and shows you the plan.
        </p>
      </div>

      <div className="panel">
        <h2>What it does</h2>
        <ul className="checklist">
          <li>
            <strong>Group structure</strong> — create a folder hierarchy from a CSV of
            group paths. Create-only: never renames, moves, or deletes.
          </li>
          <li>
            <strong>Process shortcuts</strong> — set which groups each process is shortcut
            into. Your file wins for any row it contains; blank rows change nothing.
          </li>
        </ul>
      </div>

      <div className="panel">
        <h2>Still to come</h2>
        <ul className="checklist">
          <li>Applying a plan, with journalling and resume</li>
          <li>Run progress and the audit report</li>
        </ul>
      </div>

      <footer>
        See <code>DESIGN.md</code> and <code>PLAN.md</code> in the repository.
      </footer>
    </main>
  );
}
