'use client';

import { useState } from 'react';
import { useCircleAccount } from '@/hooks/use-circle-account';

export function EmailSignIn() {
  const { state, register, login } = useCircleAccount();
  const [username, setUsername] = useState('');
  const [mode, setMode] = useState<'register' | 'login'>('register');

  const isLoading = state.status === 'loading';
  const errorMessage = state.status === 'error' ? state.message : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex rounded-lg border border-line bg-surface p-1 text-xs">
        <button
          type="button"
          onClick={() => setMode('register')}
          className={`flex-1 rounded-md px-3 py-1.5 transition ${
            mode === 'register' ? 'bg-surface-2 text-fg' : 'text-muted'
          }`}
        >
          New account
        </button>
        <button
          type="button"
          onClick={() => setMode('login')}
          className={`flex-1 rounded-md px-3 py-1.5 transition ${
            mode === 'login' ? 'bg-surface-2 text-fg' : 'text-muted'
          }`}
        >
          Sign in
        </button>
      </div>

      {mode === 'register' && (
        <input
          type="email"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="your-email@example.com"
          autoComplete="email"
          className="rounded-lg border border-line bg-bg px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none"
        />
      )}

      <button
        type="button"
        onClick={() => (mode === 'register' ? register(username.trim()) : login())}
        disabled={isLoading || (mode === 'register' && username.trim().length === 0)}
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-muted"
      >
        {isLoading
          ? 'Waiting for passkey…'
          : mode === 'register'
            ? 'Continue'
            : 'Sign in'}
      </button>

      {errorMessage && (
        <p className="text-xs text-danger break-words">{errorMessage}</p>
      )}
    </div>
  );
}
