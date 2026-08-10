'use client';

import { useState } from 'react';

interface TreeItem {
  title: string;
  itemType: string;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'working'; what: string }
  | { kind: 'error'; message: string }
  | { kind: 'signedIn'; tenant: string; username: string }
  | { kind: 'verified'; tenant: string; username: string; groups: TreeItem[] };

export default function SignInPage() {
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setStatus({ kind: 'working', what: 'Signing in…' });

    let response: Response;
    try {
      response = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ site, username, password }),
      });
    } catch {
      setStatus({ kind: 'error', message: 'Could not reach the server.' });
      return;
    }

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      tenant?: string;
      username?: string;
    };

    if (!response.ok) {
      setStatus({ kind: 'error', message: payload.error ?? 'Sign-in failed.' });
      return;
    }

    // Clear it from component state the moment it is no longer needed.
    setPassword('');
    setStatus({
      kind: 'signedIn',
      tenant: payload.tenant ?? '',
      username: payload.username ?? username,
    });
  }

  /**
   * Reads the top level of the group tree.
   *
   * This is the open question from DESIGN.md: whether a bearer token alone is enough,
   * or whether Process Manager also demands an antiforgery token on API calls made
   * outside its own pages. A successful read here settles it.
   */
  async function testConnection() {
    if (status.kind !== 'signedIn' && status.kind !== 'verified') return;
    const { tenant, username: user } = status;
    setStatus({ kind: 'working', what: 'Reading the group tree…' });

    const response = await fetch('/api/pm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'groups.tree', parentUniqueId: null }),
    });

    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
      result?: { treeItems?: TreeItem[] | null };
    };

    if (!response.ok) {
      setStatus({
        kind: 'error',
        message: [payload.error, payload.detail].filter(Boolean).join(' — '),
      });
      return;
    }

    setStatus({
      kind: 'verified',
      tenant,
      username: user,
      groups: payload.result?.treeItems ?? [],
    });
  }

  async function signOut() {
    await fetch('/api/auth', { method: 'DELETE' });
    setStatus({ kind: 'idle' });
  }

  const busy = status.kind === 'working';
  const connected = status.kind === 'signedIn' || status.kind === 'verified';

  return (
    <main>
      <h1>Sign in</h1>
      <p className="lede">
        Use your Process Manager credentials. They are exchanged for a token and are
        not stored.
      </p>

      {!connected && (
        <form onSubmit={signIn} className="panel">
          <label htmlFor="site">Process Manager address</label>
          <input
            id="site"
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="https://demo.promapp.com/your-tenant"
            autoComplete="url"
            required
          />

          <label htmlFor="username">Username</label>
          <input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />

          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          <button type="submit" disabled={busy}>
            {busy ? 'Working…' : 'Sign in'}
          </button>
        </form>
      )}

      {connected && (
        <div className="panel">
          <h2>Signed in</h2>
          <p>
            {status.username} — tenant <code>{status.tenant}</code>
          </p>
          <div className="row">
            <button type="button" onClick={testConnection} disabled={busy}>
              Test connection
            </button>
            <button type="button" className="secondary" onClick={signOut} disabled={busy}>
              Sign out
            </button>
          </div>
        </div>
      )}

      {status.kind === 'working' && (
        <div className="panel">
          <p>{status.what}</p>
        </div>
      )}

      {status.kind === 'error' && (
        <div className="panel error">
          <h2>Problem</h2>
          <p>{status.message}</p>
        </div>
      )}

      {status.kind === 'verified' && (
        <div className="panel">
          <h2>Connection works</h2>
          <p>
            Read {status.groups.length} top-level {status.groups.length === 1 ? 'item' : 'items'}.
          </p>
          <ul className="checklist">
            {status.groups.slice(0, 10).map((g) => (
              <li key={g.title}>{g.title}</li>
            ))}
          </ul>
        </div>
      )}
    </main>
  );
}
