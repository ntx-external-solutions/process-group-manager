'use client';

/**
 * The front door.
 *
 * Session and activity are tracked separately on purpose: folding "working" into the
 * same state as "signed in" makes the form flash back mid-request. Only a session the
 * server actually rejected returns someone to this form.
 */

import { useState } from 'react';

import type { SessionInfo } from '@/lib/ui/gateway.ts';

export function SignInForm({ onSignedIn }: { onSignedIn: (session: SessionInfo) => void }) {
  const [site, setSite] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
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
        expiresAt?: number;
      };

      if (!response.ok) {
        setError(payload.error ?? 'Sign-in failed.');
        return;
      }

      // Drop the password from component state as soon as it is spent.
      setPassword('');
      onSignedIn({
        tenant: payload.tenant ?? '',
        username: payload.username ?? username,
        expiresAt: payload.expiresAt ?? 0,
      });
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form onSubmit={submit} className="panel">
        <label htmlFor="site">Process Manager address</label>
        <input
          id="site"
          value={site}
          onChange={(e) => setSite(e.target.value)}
          placeholder="https://demo.promapp.com/your-tenant"
          autoComplete="url"
          disabled={busy}
          required
        />

        <label htmlFor="username">Username</label>
        <input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          disabled={busy}
          required
        />

        <label htmlFor="password">Password</label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={busy}
          required
        />

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>

      {error !== null && (
        <div className="panel error">
          <h2>Problem</h2>
          <p>{error}</p>
        </div>
      )}
    </>
  );
}
