'use client';

import { useState } from 'react';
import Link from 'next/link';
import { parseEventLogs } from 'viem';
import { usePublicClient } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { buildCreateJobUnsigned, resolveAddress } from '@/lib/api';
import { arcTestnet } from '@/lib/chains';

// Mirrors the on-chain JobCreated event from the AgenticCommerce contract.
// Used to parse the jobId out of the tx receipt after a successful createJob.
const jobCreatedEventAbi = [
  {
    type: 'event',
    name: 'JobCreated',
    inputs: [
      { name: 'jobId', type: 'uint256', indexed: true },
      { name: 'client', type: 'address', indexed: true },
      { name: 'provider', type: 'address', indexed: true },
      { name: 'evaluator', type: 'address' },
      { name: 'expiredAt', type: 'uint256' },
      { name: 'hook', type: 'address' },
    ],
  },
] as const;

// Reference contract deadline floor is exactly 5 minutes. UI default is 1 hour.
const MIN_EXPIRES_IN_SECONDS = 301;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

type Submission =
  | { status: 'idle' }
  | { status: 'resolving' }
  | { status: 'signing' }
  | { status: 'waiting'; hash: string }
  | { status: 'done'; jobId: string; txHash: string }
  | { status: 'error'; message: string };

export default function CreateJobPage() {
  const signer = useSigner();
  // Receipt parsing must read from Arc even if the wallet is currently on a
  // bridge source chain (Sepolia / Base / Arbitrum / OP).
  const publicClient = usePublicClient({ chainId: arcTestnet.id });
  const [description, setDescription] = useState('');
  const [providerInput, setProviderInput] = useState('');
  const [evaluatorInput, setEvaluatorInput] = useState('');
  const [expiresIn, setExpiresIn] = useState<number>(DEFAULT_EXPIRES_IN_SECONDS);
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
    if (expiresIn <= MIN_EXPIRES_IN_SECONDS - 1) {
      setSubmission({
        status: 'error',
        message: `Deadline must be > ${MIN_EXPIRES_IN_SECONDS - 1} seconds (reference contract floor).`,
      });
      return;
    }

    try {
      setSubmission({ status: 'resolving' });
      const provider = await resolveAddress(providerInput);
      const evaluator = await resolveAddress(evaluatorInput);

      const unsigned = await buildCreateJobUnsigned({
        provider,
        evaluator,
        expiredInSeconds: expiresIn,
        description: description.trim(),
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

      // Pull jobId from the JobCreated event in the receipt.
      if (!publicClient) throw new Error('No public client available');
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash as `0x${string}` });
      const [createdLog] = parseEventLogs({
        abi: jobCreatedEventAbi,
        eventName: 'JobCreated',
        logs: receipt.logs,
      });
      if (!createdLog) throw new Error('JobCreated event missing from receipt');
      setSubmission({ status: 'done', jobId: createdLog.args.jobId.toString(), txHash });
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
        <h1 className="mt-3 text-3xl font-semibold tracking-tight">Create a job</h1>
        <p className="mt-2 text-sm text-neutral-400">
          Post a job to the open ERC-8183 escrow on Arc. You're the <strong>client</strong>: you set
          the parties and the deadline. The provider quotes the price next (
          <code className="text-neutral-500">setBudget</code>), and you fund to accept.
        </p>
      </header>

      {!signer.isConnected && (
        <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-4 text-sm text-amber-200">
          You need to connect a wallet or sign in with a passkey before posting a job.{' '}
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
            label="Evaluator"
            hint="Who approves or rejects on delivery. Address (0x…) or handle. Often the client themselves while testing."
          >
            <input
              type="text"
              value={evaluatorInput}
              onChange={(e) => setEvaluatorInput(e.target.value)}
              placeholder="smoke-evaluator or 0x…"
              disabled={isBusy}
              className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
            />
          </Field>

          <Field
            label="Deadline"
            hint={`Seconds from now until the job expires. Reference contract requires > ${MIN_EXPIRES_IN_SECONDS - 1}.`}
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
                'Post job'}
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
                Job <span className="font-mono">#{submission.jobId}</span> created.
              </p>
              <p className="mt-1 text-xs text-neutral-400">
                Tx{' '}
                <a
                  href={`https://testnet.arcscan.app/tx/${submission.txHash}`}
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
