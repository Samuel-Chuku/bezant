'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useBalance } from 'wagmi';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useSigner } from '@/hooks/use-signer';
import { useUserRecord } from '@/hooks/use-user-record';
import { useSessionVersion } from '@/components/session-manager';
import { EmailSignIn } from '@/components/email-sign-in';
import { StruckButton, buttonClass } from '@/components/ui';
import { ProtocolChart } from '@/components/protocol-chart';
import { DealTape } from '@/components/deal-tape';
import { arcTestnet } from '@/lib/chains';
import { shortAddress, truncateBalance } from '@/lib/format';
import { timeAgo } from '@/lib/relative-time';
import {
  getUserStats,
  getPoolStats,
  getProtocolStats,
  getTradesByAddress,
  getRecentPoolStakes,
  type UserStats,
  type PoolStats,
  type ProtocolStats,
  type TradeListItem,
  type RecentPoolStake,
} from '@/lib/api';

const PlusIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);
const ArrowIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);

export default function Home() {
  const signer = useSigner();
  const { state: userState } = useUserRecord();
  const user = userState.status === 'ready' ? userState.user : null;
  const name = user?.handle ?? (signer.isConnected ? shortAddress(signer.address) : null);

  const sv = useSessionVersion();
  const [stats, setStats] = useState<UserStats | null>(null);
  const [pool, setPool] = useState<PoolStats | null>(null);
  const [proto, setProto] = useState<ProtocolStats | null>(null);
  const [trades, setTrades] = useState<TradeListItem[]>([]);
  const [recent, setRecent] = useState<RecentPoolStake[]>([]);

  const { data: usdc } = useBalance({
    address: signer.isConnected ? signer.address : undefined,
    chainId: arcTestnet.id,
    query: { enabled: signer.isConnected, refetchInterval: 15_000 },
  });

  // Global, login-free contract-derived data — polled so it reads live.
  useEffect(() => {
    let live = true;
    const load = () => {
      getProtocolStats().then((p) => live && setProto(p)).catch(() => {});
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
  }, [signer.isConnected, signer.address, sv]);

  const escrowUsdc = useMemo(
    () => trades.filter((t) => t.status === 'Funded').reduce((s, t) => s + Number(t.depositUsdc || 0), 0),
    [trades],
  );
  const available = usdc ? truncateBalance(usdc.formatted, 2) : signer.isConnected ? '…' : '—';
  const num = (v: string | number | undefined) => (v == null ? '—' : Number(v).toLocaleString());

  return (
    <main className="mx-auto max-w-[1440px] px-6 py-14">
      {/* ── HERO ─────────────────────────────────────────────── */}
      {signer.isConnected ? (
        <section className="grid items-stretch gap-6 lg:grid-cols-[1.4fr_1fr]">
          <div data-tour="hero" className="flex flex-col justify-center">
            <Eyebrow>Settlement desk</Eyebrow>
            <h1 className="mt-3 font-display text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl">
              Welcome back,<br />
              <span className="text-primary">{name}</span>.
            </h1>
            <p className="mt-4 max-w-md text-base text-muted">
              Escrow that releases on proof. Strike a bond, fund the passport-priced deposit, and settle on chain.
            </p>
            <div data-tour="start" className="mt-7 flex flex-wrap items-center gap-3">
              <StruckButton href="/trade/create" icon={<PlusIcon />}>Strike a bond</StruckButton>
              <Link href="/trade" className={buttonClass('secondary')}>Your bonds</Link>
              <Link href="/activity" className="px-2 py-2 text-sm text-muted transition hover:text-fg">Activity →</Link>
            </div>
          </div>

          <div className="bz-frame rounded-2xl border border-line bg-surface p-6">
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
              <MiniStat label="Success" value={stats?.successRate != null ? `${Math.round(stats.successRate * 100)}%` : '—'} />
            </div>
          </div>
        </section>
      ) : (
        <section className="grid items-center gap-8 lg:grid-cols-[1.3fr_1fr]">
          <div data-tour="hero">
            <Eyebrow>Settlement desk</Eyebrow>
            <h1 className="mt-3 font-display text-5xl font-semibold leading-[1.02] tracking-tight sm:text-6xl">
              Settle on <span className="text-primary">proof</span>.<br />Price on history.
            </h1>
            <p className="mt-4 max-w-lg text-base text-muted">
              Credit-priced USDC escrow that releases on verified delivery and rewrites your terms as your settled
              history grows. Sign in to strike your first bond.
            </p>
          </div>
          <div data-tour="signin" className="space-y-3">
            <div className="bz-frame rounded-2xl border border-line bg-surface p-5">
              <h3 className="font-medium text-fg">Connect a wallet</h3>
              <p className="mt-1 text-xs text-muted">MetaMask, Coinbase, WalletConnect. You keep your own keys.</p>
              <div className="mt-4"><ConnectButton /></div>
            </div>
            <div className="bz-frame rounded-2xl border border-line bg-surface p-5">
              <h3 className="font-medium text-fg">Sign in with email</h3>
              <p className="mt-1 text-xs text-muted">
                Backed by a Circle smart account on Arc. A passkey signs your transactions — no wallet required.
              </p>
              <div className="mt-4"><EmailSignIn /></div>
            </div>
          </div>
        </section>
      )}

      {/* ── YOUR MONEY (connected) — clean, no colour accents ─── */}
      {signer.isConnected && (
        <section data-tour="money" className="mt-6 grid gap-4 sm:grid-cols-3">
          <MoneyCard label="Available" value={available} unit="USDC" hint="Ready to spend on Arc" />
          <MoneyCard label="In escrow" value={escrowUsdc ? escrowUsdc.toLocaleString() : '0'} unit="USDC" hint="Locked in funded bonds" />
          <MoneyCard label="Settled volume" value={stats?.volumeUsdc ? num(stats.volumeUsdc) : '—'} unit="USDC" hint="Released to you, to date" />
        </section>
      )}

      {/* ── EVERY DEAL, ON ARC (protocol-wide live read) ─────── */}
      <section data-tour="protocol" className="mt-14">
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" aria-hidden />
          <Eyebrow>Live on Arc</Eyebrow>
        </div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <h2 className="font-display text-4xl font-semibold tracking-tight">Every deal, on chain.</h2>
          <span className="font-mono text-xs text-muted">
            {proto ? `block ${proto.blockRange.from.toLocaleString()} → ${proto.blockRange.to.toLocaleString()}` : 'Arc Testnet'}
          </span>
        </div>
        <p className="mt-2 max-w-xl text-sm text-muted">
          Read straight from the escrow contract events. Refreshed every 15 seconds.
        </p>

        {/* full-width chart */}
        <div className="bz-frame mt-6 border border-line bg-surface p-6">
          {proto ? <ProtocolChart series={proto.series} height={280} /> : <div className="h-[280px] animate-pulse bg-surface-2" />}
        </div>

        {/* protocol stat grid — uniform, clean */}
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <StatTile label="Total deals" value={proto ? String(proto.totalDeals) : '—'} sub="Struck on the protocol" />
          <StatTile label="Settled in full" value={proto ? String(proto.settled) : '—'} sub="Released to sellers" />
          <StatTile label="Disputes opened" value={proto ? String(proto.disputed) : '—'} sub="Either side contested" />
          <StatTile label="USDC funded" value={proto ? num(proto.usdcFundedUsdc) : '—'} unit="USDC" sub="Locked into escrow" />
          <StatTile label="USDC released" value={proto ? num(proto.usdcReleasedUsdc) : '—'} unit="USDC" sub="Paid on proof" />
          <StatTile label="Financed" value={proto ? String(proto.financed) : '—'} sub={proto ? `${num(proto.usdcFinancedUsdc)} USDC advanced` : undefined} />
        </div>

        {/* deal tape below the numbers, latest 7 */}
        <div className="mt-4">
          <DealTape deals={proto?.recent ?? []} limit={7} />
        </div>
      </section>

      {/* ── FINANCING POOL (after the protocol read) ─────────── */}
      <section data-tour="pool" className="mt-14">
        <Eyebrow>Financing</Eyebrow>
        <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight">The financing pool.</h2>
        <p className="mt-2 max-w-lg text-sm text-muted">
          LPs front sellers their payment the moment a buyer funds escrow, and earn the financing fees.
        </p>
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Pool TVL" value={pool ? num(pool.totalAssetsUsdc) : '—'} unit="USDC" />
          <StatTile label="Deployed" value={pool ? num(pool.outstandingUsdc) : '—'} unit="USDC" sub="In live advances" />
          <StatTile label="Idle" value={pool ? num(pool.idleUsdc) : '—'} unit="USDC" sub="Available to withdraw" />
          <StatTile label="Share price" value={pool ? pool.sharePrice.toFixed(4) : '—'} sub="NAV per share" />
        </div>
        <div className="bz-frame mt-4 grid gap-5 rounded-2xl border border-line bg-surface p-6 md:grid-cols-2">
          <div>
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Recent deposits</div>
              <Link href="/pool" className="text-xs text-muted transition hover:text-fg">Pool ›</Link>
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
                      <span className="font-mono tabular-nums text-fg">{Number(r.amountUsdc).toLocaleString()}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">{timeAgo(r.whenMs)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="md:border-l md:border-line md:pl-5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">Recently financed</div>
              <span className="font-mono text-[11px] text-muted">advances</span>
            </div>
            {!proto || proto.financedRecent.length === 0 ? (
              <p className="mt-3 text-sm text-muted">No advances drawn yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line/70">
                {proto.financedRecent.slice(0, 5).map((f) => (
                  <li key={f.txHash} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                    <Link href={`/trade/${f.tradeId}`} className="flex items-center gap-2.5 transition hover:opacity-80">
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-info" aria-hidden />
                      <span className="font-mono text-xs text-muted">#{f.tradeId}</span>
                      <span className="text-fg">advanced</span>
                      <span className="font-mono tabular-nums text-fg">{f.amountUsdc ? Number(f.amountUsdc).toLocaleString() : '—'}</span>
                    </Link>
                    <span className="shrink-0 text-xs text-muted">{f.whenMs ? timeAgo(f.whenMs) : '—'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      {/* ── QUICK ACTIONS (compact) ──────────────────────────── */}
      <section data-tour="quickstart" className="mt-14">
        <Eyebrow>Get started</Eyebrow>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <ActionTile title="Strike a bond" href="/trade/create" desc="Set terms and fund a passport-priced deposit. It releases on proof." />
          <ActionTile title="Browse the market" href="/market" desc="See open requests, make offers, get paid when delivery is attested." />
          <ActionTile title="Stake to verify" href="/verify" desc="Join the panel, vote on delivery, earn the fee." />
        </div>
      </section>

      <footer className="mt-16 inline-flex items-center gap-2 text-xs text-muted">
        Live on
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/arc-logo.svg" alt="" className="h-4 w-4" aria-hidden />
        <span className="font-mono">Arc Testnet</span> · USDC by
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/circle-icon.svg" alt="" className="h-4 w-4" aria-hidden />
        Circle
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

function MoneyCard({ label, value, unit, hint }: { label: string; value: string; unit?: string; hint: string }) {
  return (
    <div className="bz-frame rounded-2xl border border-line bg-surface p-6">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-fg">
        {value}
        {unit && <span className="ml-1.5 text-sm font-normal text-muted">{unit}</span>}
      </div>
      <div className="mt-1 text-xs text-muted">{hint}</div>
    </div>
  );
}

function StatTile({ label, value, unit, sub }: { label: string; value: string; unit?: string; sub?: string }) {
  return (
    <div className="bz-frame rounded-2xl border border-line bg-surface p-6">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">{label}</div>
      <div className="mt-2 font-mono text-3xl font-semibold tabular-nums text-fg">
        {value}
        {unit && <span className="ml-1.5 text-sm font-normal text-muted">{unit}</span>}
      </div>
      {sub && <div className="mt-1 text-xs text-muted">{sub}</div>}
    </div>
  );
}

function ActionTile({ title, desc, href }: { title: string; desc: string; href: string }) {
  return (
    <Link href={href} className="bz-frame group flex flex-col rounded-2xl border border-line bg-surface p-6 transition hover:-translate-y-0.5 hover:border-line-strong">
      <div className="flex items-center justify-between">
        <h3 className="font-display text-xl font-semibold tracking-tight">{title}</h3>
        <span className="text-muted transition group-hover:text-primary" aria-hidden><ArrowIcon /></span>
      </div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{desc}</p>
    </Link>
  );
}
