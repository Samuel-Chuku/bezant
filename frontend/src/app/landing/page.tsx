'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useReveal } from '@/hooks/use-reveal';
import { useSigner } from '@/hooks/use-signer';
import { persistTheme, readStoredTheme } from '@/lib/theme';
import './landing.css';

// Bezant marketing landing. Self-contained + token-scoped (.bezant-landing);
// the app chrome is suppressed on /landing (top-nav / sidebar / banner guards).
// Light default with a dark toggle. Mint = action, champagne = brand.

const ArrowIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
);
const CheckRing = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 12 2 2 4-4" /><circle cx="12" cy="12" r="9" /></svg>
);
const Tick = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5L20 6" /></svg>
);
const Sigil = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="1.1 1.4" /><path d="M9 12.2l2.1 2.1L15.2 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function Seal() {
  return (
    <svg className="seal" viewBox="0 0 120 120" aria-hidden>
      <g className="ring" fill="none" stroke="currentColor"><circle cx="60" cy="60" r="55" strokeWidth="1" strokeDasharray="1.3 2.3" /></g>
      <path id="bz-sealpath" d="M60,60 m-42,0 a42,42 0 1,1 84,0 a42,42 0 1,1 -84,0" fill="none" />
      <g className="ring"><text fontFamily="var(--font-mono)" fontSize="8" letterSpacing="2.2" fill="currentColor"><textPath href="#bz-sealpath" startOffset="0">ATTESTED ON CHAIN · IN GOOD STANDING · </textPath></text></g>
      <g transform="translate(46,42)" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 5 H22 M9 5 V31 M9 18 H19 a6.5 6.5 0 0 1 0 13 H9 M21 6 L11 24" /></g>
    </svg>
  );
}

const CoinMintArrow = ({ label }: { label: string }) => (
  <button className="coin mint sm" type="button"><span className="cap"><ArrowIcon /></span><span className="face">{label}</span></button>
);

// A split-flap board row: label + value rendered as flap character cells.
function BoardRow({ label, value, on }: { label: string; value: string; on?: boolean }) {
  return (
    <div className={`board-row${on ? ' on' : ''}`}>
      <span className="board-label">{label}</span>
      <span className="flaps">
        {value.split('').map((ch, i) => (ch === ' ' ? <span key={i} className="flap gap" /> : <span key={i} className="flap">{ch}</span>))}
      </span>
    </div>
  );
}

// The landing lives on the apex; the app lives on the app subdomain. In prod
// NEXT_PUBLIC_APP_URL points at it; empty in dev so CTAs stay relative (localhost).
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? '';

export default function LandingPage() {
  useReveal();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  // Connection is per-origin: on app.bezant.trade/landing this reflects the
  // signed-in app session (→ "Go back to app"); on the marketing apex it's
  // always false (→ Sign in / Open the app). Gate on mount to avoid a hydration
  // mismatch, since wallet state only exists client-side.
  const signer = useSigner();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  // Inherit any theme already chosen (e.g. in the app), and persist the effective
  // one to the shared cookie so the app subdomain inherits the landing's choice.
  useEffect(() => {
    const initial = readStoredTheme() ?? 'light';
    setTheme(initial);
    persistTheme(initial);
  }, []);
  const connected = mounted && signer.isConnected;
  return (
    <div className="bezant-landing" data-theme={theme}>
      <header className="nav"><div className="wrap nav-row">
        <span className="wordmark">bezant<span className="dot">.</span></span>
        <nav className="nav-links"><a href="#product">Product</a><a href="#protocol">Protocol</a><Link href={`${APP_URL}/docs`}>Docs</Link></nav>
        <div className="nav-right">
          <button className="toggle" type="button" aria-label="Toggle theme" onClick={() => setTheme((t) => { const next = t === 'dark' ? 'light' : 'dark'; persistTheme(next); return next; })}>◐</button>
          {connected ? (
            <Link href={`${APP_URL}/`} className="solid sm">Go back to app →</Link>
          ) : (
            <>
              <Link href={`${APP_URL}/`} className="ghost sm">Sign in</Link>
              <Link href={`${APP_URL}/`} className="solid sm">Open the app</Link>
            </>
          )}
        </div>
      </div></header>

      <main>
        {/* HERO */}
        <section className="hero"><div className="wrap hero-grid">
          <div>
            <div className="chips reveal"><span className="chip">Web3</span><span className="chip">SaaS</span><span className="chip">Fintech</span><span className="chip">Trade finance</span></div>
            <h1 className="serif reveal">Settle on <span className="accent">proof</span>.<br />Price on <span className="accent uline">history<svg viewBox="0 0 100 10" preserveAspectRatio="none" fill="none" aria-hidden><path d="M1 7 Q 26 1 50 6 T 99 5" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg></span>.</h1>
            <p className="lead reveal">Credit-priced USDC escrow that releases on verified delivery, and rewrites your terms as your settled history grows. Bonds struck between counterparties, attested on chain, redeemed in good standing.</p>
            <div className="hero-cta reveal">
              <Link href={`${APP_URL}/trade/create`} className="coin mint"><span className="cap"><PlusIcon /></span><span className="face">Strike a bond</span></Link>
              <a href="#protocol" className="ghost">Read the protocol</a>
            </div>
            <div className="trust reveal"><span className="sigil"><Sigil /></span><span className="mono">Built on Circle USDC</span><span className="dotsep" /><span className="mono">Arc network</span></div>
          </div>

          <div className="visual reveal">
            <span className="v-glow" aria-hidden />
            <Seal />
            <div className="card v-ghost" aria-hidden>
              <div className="v-row"><span className="eyebrow">Bond #4191</span><span className="mono settled">Settled</span></div>
              <div className="amount">31,500.00 <span className="u">USDC</span></div>
            </div>
            <div className="card v-main edge">
              <div className="v-row"><span className="eyebrow">Bond #4192</span><span className="live"><i />LIVE</span></div>
              <div className="amount">48,000.00 <span className="u">USDC</span></div>
              <div className="sub">Meridian Foods Ltd. · released on verified delivery</div>
              <div className="v-tracker"><span className="node done" /><span className="seg done" /><span className="node done" /><span className="seg done" /><span className="node now" /><span className="seg" /><span className="node" /></div>
              <div className="tracklabels"><span>Struck</span><span>Funded</span><span className="at">Attested</span><span>Settled</span></div>
            </div>
            <div className="card v-float v-badge"><span className="sigil"><Sigil size={18} /></span><div><div className="t1">Delivery attested</div><div className="t2">panel 4 / 4</div></div></div>
            <button className="coin ink v-float v-coin" type="button"><span className="cap"><CheckRing /></span><span className="face">Settle now<span className="meta">48,000</span></span></button>
          </div>
        </div></section>

        {/* LIFECYCLE SPINE */}
        <section id="protocol" className="board reveal"><div className="wrap">
          <div className="eyebrow">The lifecycle</div>
          <h2>Every bond, weighed and settled.</h2>
          <p className="lead">Struck between counterparties, funded at a passport-priced deposit, attested by panel, repaid on chain. The whole journey, in the open.</p>
          <div className="board-rows">
            <BoardRow label="Struck" value="TERMS SET" />
            <BoardRow label="Funded" value="100→40%" />
            <BoardRow label="Attested" value="PANEL 4 / 4" />
            <BoardRow label="Settled" value="ON CHAIN" on />
          </div>
        </div></section>

        {/* MARQUEE */}
        <div className="marquee"><div className="track">
          {[0, 1].flatMap((k) =>
            ['Built on Circle USDC', 'Arc network', 'CCTP cross-chain', 'ERC-8004 reputation', 'USYC yield', 'Gateway settlement'].map((t) => (
              <span key={`${k}-${t}`}>{t} ·</span>
            )),
          )}
        </div></div>

        {/* PILLARS */}
        <section id="product" className="wrap"><div className="case w-champ docked">
          <div className="case-left reveal">
            <div className="eyebrow">Credit passport</div>
            <h3>Your history prices the next trade.</h3>
            <p className="lead">Every bond you settle is recorded to a portable on-chain passport. When you fund the next one, Bezant reads it and sets your deposit, financing limit and terms automatically.</p>
            <div className="case-point"><span className="tick"><Tick /></span><span>Post <b>40%</b> after 30 settled bonds, not a bank&apos;s flat 100% every time.</span></div>
            <div className="case-point"><span className="tick"><Tick /></span><span>The passport travels with you across counterparties and apps.</span></div>
            <div className="case-cta"><CoinMintArrow label="See a passport" /></div>
          </div>
          <div className="case-media reveal">
            <div className="panel edge"><div className="v-row"><span className="eyebrow">Passport · 0xab12…77c4</span><span className="sigil"><Sigil /></span></div><div className="big">Tier 4 · 40% deposit</div><div className="sub">23 settled · 0 contested · in good standing</div></div>
            <div className="panel"><div className="lr top"><span className="k">Deposit required</span><span className="val">40%</span></div><div className="lr"><span className="k">Financing</span><span className="val">up to 80%</span></div><div className="lr"><span className="k">Terms</span><span className="val">net-30</span></div></div>
          </div>
        </div>

        <div className="case flip w-mint">
          <div className="case-left reveal">
            <div className="eyebrow">Verified delivery</div>
            <h3>Release on proof, not promises.</h3>
            <p className="lead">Funds stay bonded until delivery is proven. The seller uploads the manifest; a four-person panel, or an automated officer, checks it and signs on chain. Money moves only when they agree.</p>
            <div className="case-point"><span className="tick"><Tick /></span><span>Disagree with the outcome? <b>Contest it</b> before the window closes.</span></div>
            <div className="case-point"><span className="tick"><Tick /></span><span>Honest verifiers split the bonded stake; no-shows and the wrong side are slashed.</span></div>
            <div className="case-cta"><CoinMintArrow label="How verification works" /></div>
          </div>
          <div className="case-media reveal">
            <div className="panel"><div className="v-row"><span className="eyebrow">Panel vote</span><span className="mono voted">3 / 4 voted</span></div><div className="lr"><span className="k">Confirmed</span><span className="val">2</span></div><div className="lr"><span className="k">Rejected</span><span className="val">1</span></div><div className="lr"><span className="k">Awaiting</span><span className="val">1</span></div></div>
            <div className="panel edge"><span className="eyebrow">Attested</span><p className="noteline">Once the panel agrees, the attestation is written on chain and the bond can settle. No party can move funds before it lands.</p></div>
          </div>
        </div></section>

        {/* CENTERPIECE */}
        <section className="center"><div className="wrap">
          <div className="center-top">
            <div><div className="eyebrow reveal">Priced on credit</div><h2 className="reveal">Collateral you earn back.</h2></div>
            <p className="lead reveal">Banks ask for the same deposit every time. Bezant lowers yours each time you settle, until you post less than half.</p>
          </div>
          <div className="curve">
            <div className="bar reveal" style={{ height: '100%' }}><span className="pct">100%</span><span className="lab">0-2</span></div>
            <div className="bar reveal" style={{ height: '80%' }}><span className="pct">80%</span><span className="lab">6-10</span></div>
            <div className="bar reveal" style={{ height: '60%' }}><span className="pct">60%</span><span className="lab">17-22</span></div>
            <div className="bar reveal" style={{ height: '40%' }}><span className="pct">40%</span><span className="lab">30+</span></div>
          </div>
          <div className="curve-foot reveal"><span>Deposit required, by settled-trade count</span><span className="mono">floor 40%</span></div>
        </div></section>

        {/* PILLAR 3 */}
        <section className="wrap"><div className="case w-champ">
          <div className="case-left reveal">
            <div className="eyebrow">Embedded financing</div>
            <h3>Working capital while goods ship.</h3>
            <p className="lead">Draw up to 80% of the bonded deposit the day you fund, then repay it automatically when the bond settles. The financing pool earns the fee; you skip the invoice factor.</p>
            <div className="case-point"><span className="tick"><Tick /></span><span>Repaid on settlement, on chain. No collections, no chasing.</span></div>
            <div className="case-point"><span className="tick"><Tick /></span><span>Anyone can fund the pool and earn the fee plus idle <b>USYC</b> yield.</span></div>
            <div className="case-cta"><CoinMintArrow label="Open the pool" /></div>
          </div>
          <div className="case-media reveal">
            <div className="panel edge"><div className="eyebrow">Financing pool</div><div className="big">NAV 50.012</div><div className="sub">Fee yield + USYC on idle reserve</div></div>
            <div className="panel"><div className="lr top"><span className="k">Advance</span><span className="val">up to 80%</span></div><div className="lr"><span className="k">Repaid at settle</span><span className="val">on chain</span></div></div>
          </div>
        </div></section>

        {/* MANIFESTO */}
        <section className="wrap manifesto"><p className="reveal">Most trade still settles on trust it cannot verify. Bezant settles on <span className="accent">proof you can weigh</span>.</p></section>
      </main>

      {/* FOOTER */}
      <footer><span className="orb" aria-hidden /><div className="wrap">
        <p className="foot-cta reveal">Strike your first bond.</p>
        <Link href={`${APP_URL}/trade/create`} className="coin mint reveal"><span className="cap"><ArrowIcon /></span><span className="face">Open the app</span></Link>
        <div className="foot-grid">
          <div><span className="wordmark">bezant<span className="dot">.</span></span><p className="foot-desc">Trust infrastructure for stablecoin trade. Settlement you can weigh.</p></div>
          <div className="foot-col"><h5>Product</h5><a href="#">Bonds</a><a href="#">Verify</a><a href="#">Pool</a><a href="#">Bridge</a></div>
          <div className="foot-col"><h5>Protocol</h5><a href="#">Passport</a><a href="#">Verification</a><a href="#">Financing</a><a href="#">Reputation</a></div>
          <div className="foot-col"><h5>Company</h5><a href="#">Docs</a><a href="#">Careers</a><a href="#">Blog</a><a href="#">Contact</a></div>
        </div>
        <div className="socials"><a href="https://x.com/bezant_trade" target="_blank" rel="noopener">X.com</a><a href="#">LinkedIn</a><a href="https://github.com/Samuel-Chuku/bezant" target="_blank" rel="noopener">GitHub</a><a href="#">Farcaster</a><a href="#">Arc</a><span className="meta mono">Built on Circle USDC + Arc · testnet</span></div>
        <div className="foot-brand reveal" aria-hidden>bezant<span className="dot">.</span></div>
      </div></footer>
    </div>
  );
}
