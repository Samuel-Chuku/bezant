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
      <div className="flex rounded-lg border border-neutral-800 bg-neutral-900 p-1 text-xs">
        <button
          type="button"
          onClick={() => setMode('register')}
          className={`flex-1 rounded-md px-3 py-1.5 transition ${
            mode === 'register' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'
          }`}
        >
          New account
        </button>
        <button
          type="button"
          onClick={() => setMode('login')}
          className={`flex-1 rounded-md px-3 py-1.5 transition ${
            mode === 'login' ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'
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
          className="rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
        />
      )}

      <button
        type="button"
        onClick={() => (mode === 'register' ? register(username.trim()) : login())}
        disabled={isLoading || (mode === 'register' && username.trim().length === 0)}
        className="rounded-lg bg-neutral-100 px-4 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
      >
        {isLoading
          ? 'Waiting for passkey…'
          : mode === 'register'
            ? 'Continue'
            : 'Sign in'}
      </button>

      {errorMessage && (
        <p className="text-xs text-red-400 break-words">{errorMessage}</p>
      )}
    </div>
  );
}
