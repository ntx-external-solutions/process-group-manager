'use client';

import { useState } from 'react';

interface TreeItem {
  title: string;
  itemType: string;
}

interface ActiveSession {
  tenant: string;
  username: string;
}

/**
 * Session and activity are tracked separately on purpose.
 *
 * Folding "working" into the same state as "signed in" means every transient
 * operation drops the identity, and the sign-in form flashes back mid-request. The
 * upload, preview, and run screens all have the same shape — a long-lived session
 * with short-lived activity over it — so the split belongs here from the start.
 */
export default function SignInPage() {
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const [session, setSession] = useState<ActiveSession | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [groups, setGroups] = useState<TreeItem[] | null>(null);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy('Signing in…');
    setError(null);

    try {
      const response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, username, password }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        tenant?: string;
        username?: string;
      };

      if (!response.ok) {
        setError(payload.error ?? 'Sign-in failed.');
        return;
      }

      // Drop the password from component state as soon as it is spent.
      setPassword('');
      setSession({ tenant: payload.tenant ?? '', username: payload.username ?? username });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Reads the top level of the group tree — a read, nothing more.
   *
   * Confirms the deployment can authenticate against the tenant and that a bearer
   * token alone is enough for reads (see DESIGN.md).
   */
  async function testConnection() {
    setBusy('Reading the group tree…');
    setError(null);
    setGroups(null);

    try {
      const response = await fetch('/api/pm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'groups.tree', parentUniqueId: null }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
        signedOut?: boolean;
        result?: { treeItems?: TreeItem[] | null };
      };

      if (!response.ok) {
        setError([payload.error, payload.detail].filter(Boolean).join(' — '));
        // Only a rejected session should send them back to the form.
        if (payload.signedOut) setSession(null);
        return;
      }

      setGroups(payload.result?.treeItems ?? []);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(null);
    }
  }

  async function signOut() {
    setBusy('Signing out…');
    try {
      await fetch('/api/auth', { method: 'DELETE' });
    } finally {
      setSession(null);
      setGroups(null);
      setError(null);
      setBusy(null);
    }
  }

  const working = busy !== null;

  return (
    <main>
      <h1>Sign in</h1>
      <p className="lede">
        Use your Process Manager credentials. They are exchanged for a token and are
        not stored.
      </p>

      {session === null ? (
        <form onSubmit={signIn} className="panel">
          <label htmlFor="site">Process Manager address</label>
          <input
            id="site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="https://demo.promapp.com/your-tenant"
            autoComplete="url"
            disabled={working}
            required
          />

          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            disabled={working}
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            disabled={working}
            required
          />

          <button type="submit" disabled={working}>
            {working ? busy : 'Sign in'}
          </button>
        </form>
      ) : (
        <div className="panel">
          <h2>Signed in</h2>
          <p>
            {session.username} — tenant <code>{session.tenant}</code>
          </p>
          <div className="row">
            <button type="button" onClick={testConnection} disabled={working}>
              {busy === 'Reading the group tree…' ? busy : 'Test connection'}
            </button>
            <button type="button" className="secondary" onClick={signOut} disabled={working}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {error !== null && (
        <div className="panel error">
          <h2>Problem</h2>
          <p>{error}</p>
        </div>
      )}

      {groups !== null && (
        <div className="panel">
          <h2>Connection works</h2>
          <p>
            Read {groups.length} top-level {groups.length === 1 ? 'item' : 'items'}.
          </p>
          <ul className="checklist">
            {groups.slice(0, 10).map((g) => (
              <li key={g.title}>{g.title}</li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
