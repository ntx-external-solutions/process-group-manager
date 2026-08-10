'use client';

/**
 * The whole app, from the operator's point of view: sign in, look at your groups,
 * pick a job.
 *
 * There is no marketing page in front of this. The people using it have been sent here
 * to do one of two things, and anything between them and their own tenant's data is in
 * the way.
 */

import { useEffect, useState } from 'react';

import { currentSession, type SessionInfo } from '@/lib/ui/gateway.ts';
import { GroupBrowser } from './GroupBrowser.tsx';
import { SignInForm } from './SignInForm.tsx';

export default function Home() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [checking, setChecking] = useState(true);
  const [signingOut, setSigningOut] = useState(false);

  useEffect(() => {
    void currentSession().then((info) => {
      setSession(info);
      setChecking(false);
    });
  }, []);

  async function signOut() {
    setSigningOut(true);
    try {
      await fetch('/api/auth', { method: 'DELETE' });
    } finally {
      setSession(null);
      setSigningOut(false);
    }
  }

  if (checking) {
    return (
      <main>
        <h1>Process Group Manager</h1>
        <p className="lede">Checking your session…</p>
      </main>
    );
  }

  if (session === null) {
    return (
      <main>
        <h1>Process Group Manager</h1>
        <p className="lede">
          Sign in with your Process Manager credentials. They are exchanged for a token
          and are not stored.
        </p>
        <SignInForm onSignedIn={setSession} />
      </main>
    );
  }

  return (
    <main>
      <h1>Process Group Manager</h1>
      <p className="lede">
        Signed in as {session.username} — tenant <code>{session.tenant}</code>.
      </p>

      <div className="panel">
        <h2>What would you like to do?</h2>
        <p>
          Both start the same way: download or build a CSV, upload it, and see exactly
          what would change before anything is written.
        </p>
        <div className="row">
          <a className="button" href="/plan?task=groups">
            Update groups
          </a>
          <a className="button" href="/plan?task=shortcuts">
            Add shortcuts
          </a>
        </div>
      </div>

      <GroupBrowser onSignedOut={() => setSession(null)} />

      <div className="row">
        <button type="button" className="secondary" onClick={() => void signOut()} disabled={signingOut}>
          {signingOut ? 'Signing out…' : 'Sign out'}
        </button>
      </div>

      <footer>
        See <code>DESIGN.md</code> and <code>PLAN.md</code> in the repository.
      </footer>
    </main>
  );
}
