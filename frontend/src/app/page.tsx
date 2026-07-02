'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useBalance } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { useNotifications } from '@/hooks/use-notifications';
import { EmailSignIn } from '@/components/email-sign-in';
import { StruckButton, buttonClass } from '@/components/ui';
import { ActivityChart } from '@/components/activity-chart';
import { arcTestnet } from '@/lib/chains';
import { shortAddress, truncateBalance } from '@/lib/format';
import { timeAgo } from '@/lib/relative-time';
import {
  getUserStats,
  getPoolStats,
  getTradesByAddress,
  getRecentPoolStakes,
  type UserStats,
  type PoolStats,
  type TradeListItem,
  type RecentPoolStake,
} from '@/lib/api';

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);
const ArrowIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

// Short "MMM D" label for the activity axis.
const fmtDay = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function Home() {
  const signer = useSigner();
  const { state: userState } = useUserRecord();
  const user = userState.status === 'ready' ? userState.user : null;
  const name = user?.handle ?? (signer.isConnected ? shortAddress(signer.address) : null);

  const [stats, setStats] = useState<UserStats | null>(null);
  const [pool, setPool] = useState<PoolStats | null>(null);
  const [trades, setTrades] = useState<TradeListItem[]>([]);
  const [recent, setRecent] = useState<RecentPoolStake[]>([]);
  const { items: feed } = useNotifications();

  const { data: usdc } = useBalance({
    address: signer.isConnected ? signer.address : undefined,
    chainId: arcTestnet.id,
    query: { enabled: signer.isConnected, refetchInterval: 15_000 },
  });

  // Global, login-free network data — polled so it reads live off the contracts.
  useEffect(() => {
    let live = true;
    const load = () => {
      getPoolStats().then((p) => live && setPool(p)).catch(() => {});
      getRecentPoolStakes().then((r) => live && setRecent(r)).catch(() => {});
    };
    load();
    const t = setInterval(load, 15_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  // Personal stats + trades once connected.
  useEffect(() => {
    if (!signer.isConnected) {
      setStats(null);
      setTrades([]);
      return;
    }
    let live = true;
    getUserStats(signer.address).then((s) => live && setStats(s)).catch(() => {});
    getTradesByAddress(signer.address).then((t) => live && setTrades(t)).catch(() => {});
    return () => {
      live = false;
    };
  }, [signer.isConnected, signer.address]);

  // 30-day activity series bucketed from the user's real event feed.
  const chart = useMemo(() => {
    const days = 30;
    const dayMs = 86_400_000;
    const now = Date.now();
    const bins = new Array(days).fill(0);
    for (const it of feed) {
      const d = Math.floor((now - it.whenMs) / dayMs);
      if (d >= 0 && d < days) bins[days - 1 - d] += 1;
    }
    return { bins, labels: [fmtDay(now - 29 * dayMs), fmtDay(now - 14 * dayMs), 'today'] };
  }, [feed]);

  const escrowUsdc = useMemo(
    () => trades.filter((t) => t.status === 'Funded').reduce((s, t) => s + Number(t.depositUsdc || 0), 0),
    [trades],
  );
  const available = usdc ? truncateBalance(usdc.formatted, 2) : signer.isConnected ? '…' : '—';

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-14">
      {/* ── HERO ─────────────────────────────────────────────── */}
      {signer.isConnected ? (
        <section className="grid items-stretch gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div className="flex flex-col justify-center">
            <Eyebrow>Settlement desk</Eyebrow>
            <h1 className="mt-3 font-display text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl">
              Welcome back,<br />
              <span className="text-primary">{name}</span>.
            </h1>
            <p className="mt-4 max-w-md text-base text-muted">
              Escrow that releases on proof. Strike a bond, fund the passport-priced deposit, and settle on chain.
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-3">
              <StruckButton href="/trade/create" icon={<PlusIcon />}>Strike a bond</StruckButton>
              <Link href="/trade" className={buttonClass('secondary')}>Your bonds</Link>
              <Link href="/activity" className="px-2 py-2 text-sm text-muted transition hover:text-fg">Activity →</Link>
            </div>
          </div>

          {/* Standing card */}
          <div className="rounded-2xl border border-line bg-surface p-6">
            <div className="flex items-center justify-between">
              <Eyebrow>Your standing</Eyebrow>
              <Link href="/profile" className="text-xs text-muted transition hover:text-fg">Profile ›</Link>
            </div>
            <div className="mt-4 font-mono text-5xl font-semibold tabular-nums text-fg">
              {stats ? stats.tradesTotal : '—'}
              <span className="ml-2 text-sm font-normal text-muted">bonds</span>
            </div>
            <div className="mt-5 grid grid-cols-3 gap-3 border-t border-line pt-4">
              <MiniStat label="Settled" value={stats ? String(stats.settled) : '—'} tone="mint" />
              <MiniStat label="Active" value={stats ? String(stats.active) : '—'} />
              <MiniStat
                label="Success"
                value={stats?.successRate != null ? `${Math.round(stats.successRate * 100)}%` : '—'}
              />
            </div>
          </div>
        </section>
      ) : (
        <section className="grid items-center gap-8 lg:grid-cols-[1.3fr_1fr]">
          <div>
            <Eyebrow>Settlement desk</Eyebrow>
            <h1 className="mt-3 font-display text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl">
              Settle on <span className="text-primary">proof</span>.<br />Price on history.
            </h1>
            <p className="mt-4 max-w-lg text-base text-muted">
              Credit-priced USDC escrow that releases on verified delivery and rewrites your terms as your settled
              history grows. Sign in to strike your first bond.
            </p>
          </div>
          <div className="space-y-3">
            <div className="rounded-2xl border border-line bg-surface p-5">
              <h3 className="font-medium text-fg">Connect a wallet</h3>
              <p className="mt-1 text-xs text-muted">MetaMask, Coinbase, WalletConnect. You keep your own keys.</p>
              <div className="mt-4"><ConnectButton /></div>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-5">
              <h3 className="font-medium text-fg">Sign in with email</h3>
              <p className="mt-1 text-xs text-muted">
                Backed by a Circle smart account on Arc. A passkey signs your transactions — no wallet required.
              </p>
              <div className="mt-4"><EmailSignIn /></div>
            </div>
          </div>
        </section>
      )}

      {/* ── YOUR MONEY (connected) ───────────────────────────── */}
      {signer.isConnected && (
        <section className="mt-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <MoneyCard label="Available" value={available} unit="USDC" hint="Ready to spend on Arc" accent="mint" />
            <MoneyCard label="In escrow" value={escrowUsdc ? escrowUsdc.toLocaleString() : '0'} unit="USDC" hint="Locked in funded bonds" accent="info" />
            <MoneyCard label="Settled volume" value={stats ? Number(stats.volumeUsdc).toLocaleString() : '—'} unit="USDC" hint="Released to date" accent="champ" />
          </div>
        </section>
      )}

      {/* ── YOUR ACTIVITY (connected) ────────────────────────── */}
      {signer.isConnected && (
        <section className="mt-10 rounded-2xl border border-line bg-surface p-6">
          <div className="flex items-center justify-between">
            <div>
              <Eyebrow>Your activity</Eyebrow>
              <h2 className="mt-1 font-display text-2xl font-semibold tracking-tight">The last 30 days.</h2>
            </div>
            <Link href="/activity" className="text-xs text-muted transition hover:text-fg">Full feed →</Link>
          </div>
          <div className="mt-5">
            <ActivityChart data={chart.bins} labels={chart.labels} />
          </div>
        </section>
      )}

      {/* ── THREE DOORS ──────────────────────────────────────── */}
      <section className="mt-12">
        <Eyebrow>Where to start</Eyebrow>
        <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">One escrow. Three doors.</h2>
        <p className="mt-2 max-w-lg text-sm text-muted">Same escrow, same reputation — three ways in.</p>
        <div className="mt-6 grid gap-4 md:grid-cols-3">
          <DoorCard eyebrow="Buyer" title="Strike a bond" href="/trade/create" desc="Set the terms and amount. Fund a passport-priced deposit; it releases on proof." />
          <DoorCard eyebrow="Seller" title="Browse the market" href="/market" desc="See open requests, make offers, and get paid when delivery is attested." />
          <DoorCard eyebrow="Activity" title="Track deals" href="/activity" desc="Watch every bond fund, attest and settle live on Arc." highlight />
        </div>
      </section>

      {/* ── LIVE ON ARC ──────────────────────────────────────── */}
      <section className="mt-12">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          <Eyebrow>Live on Arc</Eyebrow>
        </div>
        <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">
          The financing pool, <span className="text-primary">in real time</span>.
        </h2>
        <p className="mt-2 max-w-lg text-sm text-muted">
          Read straight from the pool contract on Arc Testnet, refreshed every 15 seconds.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Pool TVL" value={pool ? Number(pool.totalAssetsUsdc).toLocaleString() : '—'} unit="USDC" featured />
          <StatTile label="Deployed" value={pool ? Number(pool.outstandingUsdc).toLocaleString() : '—'} unit="USDC" sub="In live advances" />
          <StatTile label="Idle" value={pool ? Number(pool.idleUsdc).toLocaleString() : '—'} unit="USDC" sub="Available to withdraw" />
          <StatTile label="Share price" value={pool ? pool.sharePrice.toFixed(4) : '—'} sub="NAV per share" />
        </div>

        <div className="mt-4 rounded-2xl border border-line bg-surface p-6">
          <div className="flex items-center justify-between">
            <Eyebrow>Recent deposits</Eyebrow>
            <Link href="/pool" className="text-xs text-muted transition hover:text-fg">Open pool ›</Link>
          </div>
          {recent.length === 0 ? (
            <p className="mt-3 text-sm text-muted">No deposits indexed yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line/70">
              {recent.slice(0, 5).map((r) => (
                <li key={r.key} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <span className="flex items-center gap-2.5">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    <span className="font-mono text-xs text-muted">{shortAddress(r.lp)}</span>
                    <span className="text-fg">staked</span>
                    <span className="font-mono tabular-nums text-fg">{Number(r.amountUsdc).toLocaleString()} USDC</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{timeAgo(r.whenMs)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <footer className="mt-16 text-xs text-muted">
        Live on <span className="font-mono">Arc Testnet</span> · USDC by Circle.
      </footer>
    </main>
  );
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-brand">{children}</div>;
}

function MiniStat({ label, value, tone }: { label: string; value: string; tone?: 'mint' }) {
  return (
    <div>
      <div className={`font-mono text-xl font-semibold tabular-nums ${tone === 'mint' ? 'text-primary' : 'text-fg'}`}>{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}

const MONEY_ACCENT = {
  mint: 'border-l-primary/50',
  info: 'border-l-info/50',
  champ: 'border-l-brand/50',
} as const;

function MoneyCard({
  label,
  value,
  unit,
  hint,
  accent,
}: {
  label: string;
  value: string;
  unit?: string;
  hint: string;
  accent: keyof typeof MONEY_ACCENT;
}) {
  return (
    <div className={`rounded-2xl border border-line border-l-2 ${MONEY_ACCENT[accent]} bg-surface p-6`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-fg">
        {value}
        {unit && <span className="ml-1.5 text-sm font-normal text-muted">{unit}</span>}
      </div>
      <div className="mt-1 text-xs text-muted">{hint}</div>
    </div>
  );
}

function StatTile({
  label,
  value,
  unit,
  sub,
  featured,
}: {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
  featured?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-6 ${featured ? 'border-primary/40 bg-primary/10' : 'border-line bg-surface'}`}>
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-fg">
        {value}
        {unit && <span className="ml-1.5 text-sm font-normal text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function DoorCard({
  eyebrow,
  title,
  desc,
  href,
  highlight,
}: {
  eyebrow: string;
  title: string;
  desc: string;
  href: string;
  highlight?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`group flex flex-col rounded-2xl border p-6 transition hover:-translate-y-0.5 ${
        highlight ? 'border-primary/40 bg-primary/10 hover:border-primary/60' : 'border-line bg-surface hover:border-line-strong'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-brand">{eyebrow}</div>
        <span className="text-muted transition group-hover:text-fg" aria-hidden>
          <ArrowIcon />
        </span>
      </div>
      <h3 className="mt-3 font-display text-2xl font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
    </Link>
  );
}
