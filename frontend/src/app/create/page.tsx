'use client';

import { useState } from 'react';
import Link from 'next/link';
import { parseEventLogs } from 'viem';
import { usePublicClient } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { buildCreatePactUnsigned, resolveAddress } from '@/lib/api';
import { arcTestnet } from '@/lib/chains';
import { arcExplorerTxUrl } from '@/lib/explorers';
import { useToast } from '@/components/toast';

// Mirrors PactWrapper's PactCreated event. Used to parse the pactId out of the
// tx receipt after a successful createPact.
const pactCreatedEventAbi = [
  {
    type: 'event',
    name: 'PactCreated',
    inputs: [
      { name: 'pactId', type: 'uint256', indexed: true },
      { name: 'underlyingJobId', type: 'uint256', indexed: true },
      { name: 'client', type: 'address', indexed: true },
      { name: 'provider', type: 'address' },
      { name: 'expiredAt', type: 'uint64' },
      { name: 'challengeWindow', type: 'uint64' },
      { name: 'description', type: 'string' },
    ],
  },
] as const;

// Wrapper Rule 3: minimum 30-minute deadline at creation. UI default is 1 hour.
const MIN_EXPIRES_IN_SECONDS = 1800;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
// Challenge window the client proposes at creation (the provider can adjust it
// via setBudget). Wrapper default is 24h; floor 1h, ceiling 14d.
const DEFAULT_CHALLENGE_WINDOW_SECONDS = 86400;

type Submission =
  | { status: 'idle' }
  | { status: 'resolving' }
  | { status: 'signing' }
  | { status: 'waiting'; hash: string }
  | { status: 'done'; pactId: string; txHash: string }
  | { status: 'error'; message: string };

export default function CreatePactPage() {
  const signer = useSigner();
  const toast = useToast();
  // Receipt parsing must read from Arc even if the wallet is currently on a
  // bridge source chain (Sepolia / Base / Arbitrum / OP).
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const [description, setDescription] = useState('');
  const [providerInput, setProviderInput] = useState('');
  const [expiresIn, setExpiresIn] = useState<number>(DEFAULT_EXPIRES_IN_SECONDS);
  const [challengeWindow, setChallengeWindow] = useState<number>(DEFAULT_CHALLENGE_WINDOW_SECONDS);
  const [submission, setSubmission] = useState<Submission>({ status: 'idle' });

  const submit = async () => {
    if (!signer.isConnected) {
      setSubmission({ status: 'error', message: 'Connect a wallet first.' });
      return;
    }
    if (description.trim().length === 0) {
      setSubmission({ status: 'error', message: 'Description is required.' });
      return;
    }
    if (expiresIn < MIN_EXPIRES_IN_SECONDS) {
      setSubmission({
        status: 'error',
        message: `Deadline must be at least ${MIN_EXPIRES_IN_SECONDS} seconds (wrapper 30-minute floor).`,
      });
      return;
    }

    try {
      setSubmission({ status: 'resolving' });
      const provider = await resolveAddress(providerInput);

      const unsigned = await buildCreatePactUnsigned({
        provider,
        expiredInSeconds: expiresIn,
        description: description.trim(),
        challengeWindowSeconds: challengeWindow,
      });

      setSubmission({ status: 'signing' });
      const sent = await signer.sendCall({
        to: unsigned.to,
        data: unsigned.data,
        value: BigInt(unsigned.value),
      });

      setSubmission({ status: 'waiting', hash: sent.hash });
      const { txHash, status } = await sent.wait();
      if (status !== 'success') throw new Error(`Tx ${status}`);

      // Pull pactId from the on-chain PactCreated event in the receipt.
      if (!publicClient) throw new Error('No public client available');
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const [createdLog] = parseEventLogs({
        abi: pactCreatedEventAbi,
        eventName: 'PactCreated',
        logs: receipt.logs,
      });
      if (!createdLog) throw new Error('PactCreated event missing from receipt');
      const newPactId = createdLog.args.pactId.toString();
      setSubmission({ status: 'done', pactId: newPactId, txHash });
      toast.success(`Pact #${newPactId} created`);
    } catch (err) {
      setSubmission({
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const isBusy =
    submission.status === 'resolving' ||
    submission.status === 'signing' ||
    submission.status === 'waiting';

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-8">
        <Link href="/" className="text-xs text-neutral-500 hover:text-neutral-100">
          ← back
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Create a pact</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Post a pact to the escrow on Arc. You're the <strong>client</strong>: you set the provider,
          the deadline, and the challenge window. The provider quotes the price next (
          <code className="text-neutral-500">setBudget</code>), and you fund to accept.
        </p>
      </header>

      {!signer.isConnected && (
        <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
          You need to connect a wallet or sign in with a passkey before posting a pact.{' '}
          <Link href="/" className="underline">
            Go to sign-in
          </Link>
          .
        </div>
      )}

      {signer.isConnected && (
        <section className="space-y-5 rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6">
          <Field label="Description" hint="What's being done? Short and specific.">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="Write 3 product taglines for an AI coffee company."
              disabled={isBusy}
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
          </Field>

          <Field
            label="Provider"
            hint="Who will do the work. Address (0x…) or a registered handle."
          >
            <input
              type="text"
              value={providerInput}
              onChange={(e) => setProviderInput(e.target.value)}
              placeholder="smoke-provider or 0x…"
              disabled={isBusy}
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
          </Field>

          <Field
            label="Deadline"
            hint={`Seconds from now until the pact expires. Minimum ${MIN_EXPIRES_IN_SECONDS} (30 min).`}
          >
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={MIN_EXPIRES_IN_SECONDS}
                value={expiresIn}
                onChange={(e) => setExpiresIn(Number(e.target.value))}
                disabled={isBusy}
                className="w-32 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
              />
              <div className="flex gap-2 text-xs">
                {[
                  ['1h', 3600],
                  ['1d', 86400],
                  ['1w', 604800],
                ].map(([label, value]) => (
                  <button
                    key={label as string}
                    type="button"
                    onClick={() => setExpiresIn(value as number)}
                    disabled={isBusy}
                    className="rounded-md border border-neutral-800 px-2 py-1 text-neutral-400 hover:text-neutral-100"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          <Field
            label="Challenge window"
            hint="After the provider submits, how long the client can dispute before payout auto-releases. The provider can adjust this when quoting. 1h–14d."
          >
            <div className="flex items-center gap-3">
              <input
                type="number"
                min={3600}
                value={challengeWindow}
                onChange={(e) => setChallengeWindow(Number(e.target.value))}
                disabled={isBusy}
                className="w-32 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-600 focus:outline-none"
              />
              <div className="flex gap-2 text-xs">
                {[
                  ['1h', 3600],
                  ['24h', 86400],
                  ['7d', 604800],
                ].map(([label, value]) => (
                  <button
                    key={label as string}
                    type="button"
                    onClick={() => setChallengeWindow(value as number)}
                    disabled={isBusy}
                    className="rounded-md border border-neutral-800 px-2 py-1 text-neutral-400 hover:text-neutral-100"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          <div className="border-t border-neutral-800 pt-4">
            <button
              type="button"
              onClick={submit}
              disabled={isBusy}
              className="rounded-lg bg-neutral-100 px-5 py-2 text-sm font-medium text-neutral-950 transition hover:bg-white disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
            >
              {submission.status === 'resolving' && 'Resolving addresses…'}
              {submission.status === 'signing' && 'Waiting for signature…'}
              {submission.status === 'waiting' && 'Waiting for tx to confirm…'}
              {(submission.status === 'idle' ||
                submission.status === 'done' ||
                submission.status === 'error') &&
                'Post pact'}
            </button>
            <p className="mt-3 text-xs text-neutral-500">
              Signing as <span className="font-mono">{signer.address}</span> (
              {signer.mode === 'external' ? 'external wallet' : 'passkey'}).
            </p>
          </div>

          {submission.status === 'error' && (
            <p className="rounded-lg border border-red-900/40 bg-red-950/20 px-3 py-2 text-xs text-red-400 break-words">
              {submission.message}
            </p>
          )}

          {submission.status === 'done' && (
            <div className="rounded-lg border border-emerald-900/40 bg-emerald-950/20 p-4 text-sm">
              <p className="font-medium text-emerald-300">
                Pact <span className="font-mono">#{submission.pactId}</span> created.
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                Tx{' '}
                <a
                  href={arcExplorerTxUrl(submission.txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-emerald-400 underline"
                >
                  {submission.txHash.slice(0, 10)}…{submission.txHash.slice(-6)}
                </a>
                . Next step: the provider sets a price (setBudget).
              </p>
            </div>
          )}
        </section>
      )}
    </main>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-neutral-200">{label}</label>
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}
