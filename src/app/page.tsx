/**
 * Placeholder landing page.
 *
 * Deliberately says what does and does not exist yet. The sign-in and upload flows
 * arrive with milestones 4 and 6; shipping a convincing-looking shell before the
 * safety machinery is built would invite someone to try running a bulk change.
 */
export default function Home() {
  return (
    <main>
      <h1>Process Group Manager</h1>
      <p className="lede">
        Bulk group-structure and shortcut management for Nintex Process Manager.
      </p>

      <div className="panel">
        <h2>Not ready to use</h2>
        <p>
          This deployment builds the shell only. There is no sign-in yet, and the tool
          cannot read from or write to any Process Manager tenant.
        </p>
      </div>

      <div className="panel">
        <h2>Built so far</h2>
        <ul className="checklist">
          <li>CSV parsing, group-path normalisation, and validation</li>
          <li>Group-structure planner — create-only, never moves or deletes</li>
          <li>Shortcut planner — replace semantics, with per-process write routing</li>
          <li>Templates and current-state exports</li>
        </ul>
      </div>

      <div className="panel">
        <h2>Still to come</h2>
        <ul className="checklist">
          <li>Process Manager API client and the allowlisted proxy routes</li>
          <li>Sign-in</li>
          <li>Executor with journalling and resume</li>
          <li>Upload, preview, and run screens</li>
        </ul>
      </div>

      <footer>
        See <code>DESIGN.md</code> and <code>PLAN.md</code> in the repository.
      </footer>
    </main>
  );
}
