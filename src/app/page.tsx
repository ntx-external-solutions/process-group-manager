/**
 * Landing page.
 *
 * Says plainly what the tool does. It now writes, so the front page leads with the
 * order of operations — upload, preview, then apply — rather than with a reassurance
 * that nothing can change.
 */
export default function Home() {
  return (
    <main>
      <h1>Process Group Manager</h1>
      <p className="lede">
        Bulk group-structure and shortcut management for Nintex Process Manager.
      </p>

      <div className="panel">
        <h2>Start here</h2>
        <p>
          <a href="/signin">Sign in</a>, then <a href="/plan">upload a CSV</a>. You see
          exactly what would change before anything is written, and nothing is applied
          until you press Apply.
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
        <h2>If a run is interrupted</h2>
        <p>
          Close the tab mid-run and nothing is lost or half-done: apply the same file
          again and anything that already completed is skipped rather than repeated. Every
          run produces a report listing what changed, what was skipped, and why.
        </p>
      </div>

      <footer>
        See <code>DESIGN.md</code> and <code>PLAN.md</code> in the repository.
      </footer>
    </main>
  );
}
