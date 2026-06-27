'use client';

import Link from 'next/link';
import { BezantMark } from '@/components/bezant-logo';
import { useReveal } from '@/hooks/use-reveal';

// Bezant marketing landing. Self-contained (the app chrome is suppressed on
// /landing): own nav + footer. Built on the Ink & Mint tokens, the type scale
// (.t-* utilities), and the bz-* keyframes. Composition + scroll language are
// adapted from the patterns harvested in Arc/SKILL.md. Mint = action,
// champagne (text-brand) = brand/verification - never swapped.

const PILL_MINT =
  'inline-flex h-12 items-center justify-center gap-2 rounded-full bg-primary px-6 text-[15px] font-semibold text-primary-fg transition hover:bg-primary-hover';
const PILL_GHOST =
  'inline-flex h-12 items-center justify-center gap-2 rounded-full border border-line px-6 text-[15px] font-semibold text-fg transition hover:bg-surface';
const PILL_SM_MINT =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full bg-primary px-4 text-sm font-semibold text-primary-fg transition hover:bg-primary-hover';
const PILL_SM_GHOST =
  'inline-flex h-10 items-center justify-center gap-2 rounded-full border border-line px-4 text-sm font-semibold text-fg transition hover:bg-surface';
const ICON_BTN =
  'inline-flex h-10 w-10 items-center justify-center rounded-full border border-line bg-surface-2 text-fg';

const CHIP = 'rounded-full border border-line bg-surface-2 px-3 py-1.5 text-xs text-muted';

export default function LandingPage() {
  useReveal();
  return (
    <div className="min-h-svh bg-bg text-fg">
      <Nav />
      <main>
        <Hero />
        <Marquee />
        <Pillars />
        <HowItWorks />
        <Stats />
      </main>
      <Footer />
    </div>
  );
}

function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`font-display font-medium tracking-tight text-brand ${className}`}>
      bezant<span className="text-primary">.</span>
    </span>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-bg/80 backdrop-blur">
      <div className="mx-auto flex h-[68px] max-w-6xl items-center gap-7 px-6">
        <Link href="/landing" aria-label="Bezant">
          <Wordmark className="text-[22px]" />
        </Link>
        <nav className="ml-2 hidden gap-1 md:flex">
          {['Product', 'Protocol', 'Pricing', 'Docs'].map((l) => (
            <a key={l} href="#" className="rounded-lg px-3 py-2 text-sm text-muted transition hover:text-fg">
              {l}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link href="/" className={`${PILL_SM_GHOST} hidden sm:inline-flex`}>Sign in</Link>
          <Link href="/" className={PILL_SM_MINT}>Open the app</Link>
        </div>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="relative mx-auto max-w-6xl px-6 pb-10 pt-16 sm:pt-20">
      <Seal className="absolute right-6 top-16 hidden h-32 w-32 lg:block" />
      <div className="reveal flex flex-wrap gap-2">
        {['Web3', 'SaaS', 'Fintech', 'Trade finance'].map((c) => (
          <span key={c} className={CHIP}>{c}</span>
        ))}
      </div>
      <h1 className="reveal t-display-1 mt-6 max-w-[16ch]">Trade, settled.</h1>
      <p className="reveal t-body-lg mt-5 max-w-[54ch]">
        Credit-priced USDC escrow that releases on verified delivery. Bonds struck between
        counterparties, attested on chain, redeemed in good standing.
      </p>
      <div className="reveal mt-8 flex flex-wrap gap-3">
        <Link href="/trade/create" className={PILL_MINT}>Strike a bond</Link>
        <a href="#how" className={PILL_GHOST}>Read the protocol</a>
      </div>

      {/* full-bleed product band */}
      <div className="reveal mt-14 grid grid-cols-1 gap-4 md:grid-cols-3">
        <Shot eyebrow="Escrow ledger" badge="Settled" tone="settled">
          <LedgerRow label="#4192 · Meridian Foods" value="48,000.00" />
          <LedgerRow label="#4188 · Kestrel" value="12,500.00" />
          <LedgerRow label="#4181 · Aster" value="92,000.00" />
        </Shot>
        <Shot eyebrow="Bond #4192" badge="Verified" tone="verified">
          <div className="mt-auto t-data-lg text-fg">
            48,000.00 <span className="text-sm text-muted">USDC</span>
          </div>
          <p className="t-body-sm text-muted">Released to the seller on verified delivery.</p>
        </Shot>
        <Shot eyebrow="Verify panel" badge="Pending" tone="pending">
          <LedgerRow label="Manifest" value="attested" />
          <LedgerRow label="Panel · 4 verifiers" value="3 / 4" />
          <LedgerRow label="Window" value="06h 04m" />
        </Shot>
      </div>
    </section>
  );
}

function Shot({
  eyebrow,
  badge,
  tone,
  children,
}: {
  eyebrow: string;
  badge: string;
  tone: BadgeTone;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[188px] flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="t-eyebrow text-brand">{eyebrow}</span>
        <Badge tone={tone}>{badge}</Badge>
      </div>
      {children}
    </div>
  );
}

function LedgerRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-t border-line/60 py-2.5">
      <span className="text-sm text-muted">{label}</span>
      <span className="t-data-sm text-fg">{value}</span>
    </div>
  );
}

type BadgeTone = 'verified' | 'settled' | 'pending';
function Badge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  const cls = {
    verified: 'border-brand text-brand',
    settled: 'border-primary text-primary',
    pending: 'border-warn text-warn',
  }[tone];
  return (
    <span className={`rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${cls}`}>
      {children}
    </span>
  );
}

function Marquee() {
  const items = [
    'Built on Circle USDC', 'Arc network', 'CCTP cross-chain',
    'ERC-8004 reputation', 'USYC yield', 'Gateway settlement',
  ];
  const track = [...items, ...items];
  return (
    <div className="mt-16 overflow-hidden border-y border-line py-5 [mask-image:linear-gradient(90deg,transparent,#000_8%,#000_92%,transparent)]">
      <div className="flex w-max gap-14 animate-[bz-marquee_28s_linear_infinite] hover:[animation-play-state:paused]">
        {track.map((t, i) => (
          <span key={i} className="t-data-sm whitespace-nowrap text-muted">{t}</span>
        ))}
      </div>
    </div>
  );
}

const PILLARS = [
  {
    n: '01 · Credit passport',
    h: 'History rewrites your next trade.',
    b: "Every settled bond accrues to a portable on-chain passport. It sets the next trade's deposit, terms, and financing automatically. Executable policy, not a score.",
    cta: 'See a passport',
    media: (
      <>
        <Panel edge>
          <span className="t-eyebrow text-brand">Passport · 0xab12…77c4</span>
          <div className="mt-3.5 t-data-lg text-fg">Tier 4 · 40% deposit</div>
          <p className="mt-2 t-body-sm text-muted">23 settled · 0 contested · in good standing</p>
        </Panel>
        <Panel>
          <p className="t-body-sm text-muted">Next bond</p>
          <LedgerRow label="Deposit required" value="40%" />
          <LedgerRow label="Financing" value="up to 80%" />
          <LedgerRow label="Terms" value="net-30" />
        </Panel>
      </>
    ),
  },
  {
    n: '02 · Verified delivery',
    h: 'Release on proof, not promises.',
    b: 'A decentralized panel weighs the delivery against the manifest, or an automated officer attests. Funds release only when delivery is attested on chain.',
    cta: 'How verification works',
    media: (
      <>
        <Panel>
          <div className="flex items-center justify-between">
            <span className="t-eyebrow text-brand">Panel vote</span>
            <Badge tone="pending">3 / 4</Badge>
          </div>
          <LedgerRow label="Confirmed" value="2" />
          <LedgerRow label="Rejected" value="1" />
          <LedgerRow label="Awaiting" value="1" />
        </Panel>
        <Panel edge>
          <span className="t-eyebrow text-brand">Attested</span>
          <p className="mt-2.5 t-body-sm text-muted">Delivery weighed against the manifest. Stake bonded; minority slashed.</p>
        </Panel>
      </>
    ),
  },
  {
    n: '03 · Embedded financing',
    h: 'Working capital while goods ship.',
    b: 'A USDC reserve fronts the seller against the bonded deposit, repaid at settlement. LPs earn the fee plus idle USYC yield. No bank in the loop.',
    cta: 'Open the pool',
    media: (
      <>
        <Panel>
          <div className="flex items-center justify-between">
            <span className="t-eyebrow text-brand">Financing pool</span>
            <Badge tone="settled">Live</Badge>
          </div>
          <div className="mt-3.5 t-data-lg text-fg">NAV 50.012</div>
          <p className="mt-1.5 t-body-sm text-muted">Fee yield + USYC on idle</p>
        </Panel>
        <Panel>
          <LedgerRow label="Advance" value="80%" />
          <LedgerRow label="Repaid at settle" value="on chain" />
        </Panel>
      </>
    ),
  },
];

function Pillars() {
  return (
    <section className="mx-auto max-w-6xl px-6">
      <div className="flex flex-wrap items-end justify-between gap-5 pb-9 pt-24">
        <div>
          <div className="reveal t-eyebrow text-brand">What holds it up</div>
          <h2 className="reveal t-h1 mt-3 max-w-[18ch]">Three things no bank product can price together.</h2>
        </div>
        <a href="#how" className={`reveal ${PILL_SM_GHOST}`}>Read the protocol</a>
      </div>
      {PILLARS.map((p) => (
        <div key={p.n} className="grid grid-cols-1 gap-12 border-t border-line py-16 lg:grid-cols-[0.85fr_1.15fr]">
          <div className="reveal lg:sticky lg:top-[104px] lg:self-start">
            <div className="t-eyebrow text-brand">{p.n}</div>
            <h2 className="t-h2 mb-4 mt-3.5">{p.h}</h2>
            <p className="t-body-lg">{p.b}</p>
            <div className="mt-5 flex items-center gap-2.5">
              <a href="#" className={PILL_SM_MINT}>{p.cta}</a>
              <span className={ICON_BTN} aria-hidden>→</span>
            </div>
          </div>
          <div className="reveal flex flex-col gap-4">{p.media}</div>
        </div>
      ))}
    </section>
  );
}

function Panel({ edge = false, children }: { edge?: boolean; children: React.ReactNode }) {
  return (
    <div className={`min-h-[120px] rounded-[18px] border border-line bg-surface p-5 ${edge ? 'border-l-2 border-l-brand/30' : ''}`}>
      {children}
    </div>
  );
}

function HowItWorks() {
  const steps = [
    { e: 'Struck', t: 'A bond is struck', d: 'Buyer and seller agree terms. USDC is bonded into credit-priced escrow on Arc.', edge: false },
    { e: 'Attested', t: 'Delivery is attested', d: 'A verifier panel confirms delivery against the manifest, on chain.', edge: false },
    { e: 'Settled', t: 'The bond settles', d: 'Funds redeem to the seller. Reputation accrues to both parties in good standing.', edge: true },
  ];
  return (
    <section id="how" className="mx-auto max-w-6xl px-6 py-24">
      <div className="mb-9">
        <div className="reveal t-eyebrow text-brand">How it works</div>
        <h2 className="reveal t-h1 mt-3">Struck, attested, settled.</h2>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {steps.map((s) => (
          <div key={s.e} className={`reveal rounded-2xl border border-line bg-surface p-6 ${s.edge ? 'border-l-2 border-l-brand/30' : ''}`}>
            <div className="t-eyebrow text-brand">{s.e}</div>
            <h3 className="mb-2 mt-3.5 font-sans text-xl font-semibold">{s.t}</h3>
            <p className="t-body-sm text-muted">{s.d}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Stats() {
  const stats = [
    { v: '$48.2M', l: 'Settled to date' },
    { v: '1,204', l: 'Bonds in good standing' },
    { v: '0.4%', l: 'Contested' },
  ];
  return (
    <section className="mx-auto max-w-6xl px-6 pb-24">
      <div className="reveal flex flex-wrap items-center justify-center gap-12 text-center">
        {stats.map((s) => (
          <div key={s.l}>
            <div className="t-data-lg text-fg">{s.v}</div>
            <div className="mt-1.5 t-body-sm text-muted">{s.l}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line bg-bg pb-10 pt-20">
      <div className="mx-auto max-w-6xl px-6">
        <p className="reveal t-display-2 mb-7 max-w-[14ch]">Strike your first bond.</p>
        <Link href="/trade/create" className={`reveal ${PILL_MINT}`}>Open the app</Link>
        <div className="mt-16 grid grid-cols-2 gap-8 border-t border-line pt-10 md:grid-cols-[1.5fr_repeat(3,1fr)]">
          <div>
            <Wordmark className="text-2xl" />
            <p className="mt-3.5 max-w-[30ch] t-body-sm text-muted">
              Trust infrastructure for stablecoin trade. Settlement you can weigh.
            </p>
          </div>
          <FootCol title="Product" links={['Bonds', 'Verify', 'Pool', 'Bridge']} />
          <FootCol title="Protocol" links={['Passport', 'Verification', 'Financing', 'Reputation']} />
          <FootCol title="Company" links={['Docs', 'Careers', 'Blog', 'Contact']} />
        </div>
        <div className="mt-10 flex flex-wrap items-center gap-5 border-t border-line pt-6">
          {['X.com', 'LinkedIn', 'GitHub', 'Farcaster', 'Arc'].map((s) => (
            <a key={s} href="#" className="text-xs uppercase tracking-[0.14em] text-muted transition hover:text-brand">{s}</a>
          ))}
          <span className="ml-auto text-xs text-muted">Built on Circle USDC + Arc · testnet</span>
        </div>
      </div>
    </footer>
  );
}

function FootCol({ title, links }: { title: string; links: string[] }) {
  return (
    <div>
      <h4 className="mb-3.5 text-xs font-semibold uppercase tracking-[0.14em] text-muted">{title}</h4>
      {links.map((l) => (
        <a key={l} href="#" className="block py-1.5 text-sm text-fg/90 transition hover:text-primary">{l}</a>
      ))}
    </div>
  );
}

// Rotating champagne assay seal wrapping the B+Z mark. Champagne = brand, so it
// never carries an action. Rotation pauses under prefers-reduced-motion (global).
function Seal({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" className={className} aria-hidden="true">
      <defs>
        <path id="sealpath" d="M60,60 m-42,0 a42,42 0 1,1 84,0 a42,42 0 1,1 -84,0" fill="none" />
      </defs>
      <g className="origin-center animate-[bz-rotate_24s_linear_infinite] [transform-box:fill-box]">
        <circle cx="60" cy="60" r="55" fill="none" stroke="rgb(var(--brand))" strokeWidth="1" strokeDasharray="1.4 2.4" />
        <text className="font-mono" fontSize="8.5" letterSpacing="2.4" fill="rgb(var(--brand))">
          <textPath href="#sealpath" startOffset="0">$48.2M SETTLED · IN GOOD STANDING · </textPath>
        </text>
      </g>
      <BezantMark size={34} decorative className="text-brand [transform:translate(43px,43px)]" />
    </svg>
  );
}
