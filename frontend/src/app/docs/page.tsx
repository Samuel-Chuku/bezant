import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { ContextHeader } from '@/components/ui';
import { ArchitectureDiagram } from '@/components/architecture-diagram';

export const metadata: Metadata = {
  title: 'Docs',
  description: 'How Bezant works — credit-priced USDC escrow, verified delivery, embedded financing, and an on-chain credit passport.',
};

// Static product documentation. Long-form scroll with a sticky table of contents;
// server-rendered (no client interactivity needed). Mirrors the submission PDF so
// judges and users read the same source of truth.

const TOC: { id: string; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'lifecycle', label: 'Bond lifecycle' },
  { id: 'passport', label: 'Credit passport' },
  { id: 'verification', label: 'Verified delivery' },
  { id: 'financing', label: 'Embedded financing' },
  { id: 'circle', label: 'Circle stack' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'status', label: 'Status & honesty' },
];

export default function DocsPage() {
  return (
    <main className="mx-auto max-w-[1200px] px-6 py-16">
      <ContextHeader
        eyebrow="Documentation"
        title="How Bezant works"
        meta="Credit-priced USDC escrow that releases on verified delivery, lets sellers draw working capital while goods ship, and rewrites both sides' terms as their settled history grows. Built end-to-end on Circle and Arc."
      />

      <div className="mt-12 grid gap-12 lg:grid-cols-[220px_minmax(0,1fr)]">
        {/* Sticky TOC */}
        <aside className="hidden lg:block">
          <nav className="sticky top-24 space-y-1">
            <div className="mb-3 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted">On this page</div>
            {TOC.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className="block rounded-md px-3 py-1.5 text-sm text-muted transition hover:bg-surface hover:text-fg"
              >
                {t.label}
              </a>
            ))}
          </nav>
        </aside>

        <div className="min-w-0 space-y-16">
          <Section id="overview" title="Overview">
            <P>
              Cross-border trade still settles on trust it cannot verify. A buyer wires money and hopes goods arrive; a supplier
              ships goods and waits weeks to be paid; and neither party&apos;s good track record counts for anything the next time.
              Bezant replaces that with <B>bonds</B> — USDC escrows struck between two counterparties, priced by their on-chain
              history, released only on verified delivery, and recorded to a portable credit passport when they settle.
            </P>
            <P>Four things happen in one flow:</P>
            <ul className="mt-2 space-y-2 text-fg/90">
              <Bullet><B>Escrow</B> — the buyer funds the full trade amount in USDC; the seller is paid in full on delivery.</Bullet>
              <Bullet><B>Verification</B> — delivery is checked by an automated Trade Officer or a staked human panel before funds move.</Bullet>
              <Bullet><B>Financing</B> — the seller can draw working capital against the bond the day it&apos;s funded, repaid automatically at settlement.</Bullet>
              <Bullet><B>Reputation</B> — every clean settlement writes to both parties&apos; credit passport, which then prices their next trade.</Bullet>
            </ul>
          </Section>

          <Section id="lifecycle" title="Bond lifecycle">
            <P>A bond moves through six states. Every transition is on chain.</P>
            <ol className="mt-4 space-y-4">
              <Step n={1} title="Struck">
                The buyer strikes a bond with a supplier: trade amount, delivery milestone, deadline, and how delivery will be
                verified (automated officer or staked panel).
              </Step>
              <Step n={2} title="Funded">
                The buyer funds the escrow with the full trade amount in USDC — from their wallet, their Circle Gateway unified
                balance, or bridged in via CCTP. The seller is now guaranteed payment on delivery.
              </Step>
              <Step n={3} title="Advance (optional)">
                The seller draws an advance from the financing pool against the funded bond — cash now instead of waiting out the
                delivery window. It&apos;s repaid automatically when the bond settles.
              </Step>
              <Step n={4} title="Delivered">
                The seller ships and submits a delivery document (e.g. a bill of lading with a real reference number) plus any
                supporting files.
              </Step>
              <Step n={5} title="Attested">
                The Trade Officer examines the document and attests, or the staked panel votes. The attestation is written on
                chain; no party can move funds before it lands. Either side can contest before the window closes.
              </Step>
              <Step n={6} title="Settled">
                On a positive attestation the escrow releases the full amount to the seller (net of any advance repaid to the
                pool). Both passports are updated.
              </Step>
            </ol>
          </Section>

          <Section id="passport" title="Credit passport">
            <P>
              Every bond a party settles is recorded to an on-chain <B>credit passport</B> (<Code>TradePassport</Code>) — a
              verifiable, portable record of completed trades and repayment behaviour. The passport isn&apos;t cosmetic: it drives
              real terms.
            </P>
            <ul className="mt-2 space-y-2 text-fg/90">
              <Bullet>A stronger settled-trade history lowers the deposit tier and raises the financing limit available on the next bond.</Bullet>
              <Bullet>The passport travels with the account across counterparties — reputation you can price, not a score locked inside one bank.</Bullet>
              <Bullet>It is the underwriting layer for buyer-side credit as the protocol matures.</Bullet>
            </ul>
          </Section>

          <Section id="verification" title="Verified delivery">
            <P>Funds stay bonded until delivery is proven. Bezant offers two verification modes, chosen when the bond is struck.</P>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Card title="Trade Officer — automated">
                An AI examiner reviews the delivery document for coherence and authenticity, then attests with a written verdict
                visible to both buyer and seller. Fast and cheap. This is <B>documentary</B> verification — it reads the paper,
                it does not physically inspect goods, and the product says so plainly.
              </Card>
              <Card title="Staked panel — real people">
                A panel of human verifiers stakes USDC and votes on delivery. Honest verifiers split the bonded stake; no-shows
                and the wrong side are slashed, so honesty is the profitable move. Recommended for higher-value or physical goods
                where you want real human review, not just a document check.
              </Card>
            </div>
          </Section>

          <Section id="financing" title="Embedded financing">
            <P>
              Suppliers shouldn&apos;t have to wait out the delivery window to get paid. The <Code>FinancingPool</Code> fronts the
              seller a working-capital advance the moment a buyer funds escrow, repaid automatically on settlement — no invoice
              factor, no collections, no chasing.
            </P>
            <ul className="mt-2 space-y-2 text-fg/90">
              <Bullet>Anyone with a Bezant account can deposit USDC into the pool, receive shares, and earn the financing fees as yield — no whitelist, no minimum.</Bullet>
              <Bullet>The pool&apos;s idle liquidity is held in <B>USYC</B>, Circle&apos;s yield-bearing instrument, so LPs earn on idle treasury float instead of letting it sit dead.</Bullet>
              <Bullet>LPs bear credit risk: if a financed bond is refunded or a dispute is lost, the advance is written off and shared across LPs. Withdrawals are capped at idle liquidity.</Bullet>
            </ul>
          </Section>

          <Section id="circle" title="Circle stack">
            <P>Bezant is built on Circle&apos;s products end to end. Each one does real work in the flow:</P>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-muted">
                    <th className="py-2 pr-4 font-medium">Product</th>
                    <th className="py-2 font-medium">How Bezant uses it</th>
                  </tr>
                </thead>
                <tbody className="text-fg/90">
                  <ProductRow p="USDC">Settlement currency for every bond, and the gas token on Arc.</ProductRow>
                  <ProductRow p="Circle Wallets">Onboarding — users get a wallet without touching seed phrases.</ProductRow>
                  <ProductRow p="Circle Gateway">Unified USDC balance across chains; buyers fund escrow straight from it, sellers route payouts to the chain they operate on.</ProductRow>
                  <ProductRow p="CCTP / Bridge Kit">Native cross-chain USDC — burn on the source chain, mint on Arc — to fund a bond from funds held elsewhere.</ProductRow>
                  <ProductRow p="USYC">Idle financing-pool liquidity earns yield instead of sitting dead.</ProductRow>
                  <ProductRow p="Arc network">The USDC-native L1 the whole protocol settles on.</ProductRow>
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="architecture" title="Architecture">
            <P>
              A Next.js app talks to a Fastify backend and a set of purpose-built contracts on Arc. The backend indexes chain
              events into bond state, runs the Trade Officer, draws verifier panels, and sends notifications. Every settlement
              updates both passports.
            </P>
            <div className="bz-frame mt-6 rounded-xl border border-line bg-surface p-4 sm:p-6">
              <ArchitectureDiagram />
            </div>
          </Section>

          <Section id="contracts" title="Contracts">
            <P>Four Solidity contracts, deployed on Arc testnet:</P>
            <div className="mt-4 space-y-3">
              <ContractRow name="TradeEscrow">Holds the bonded USDC; handles fund, settle, refund, and financing hooks. The spine of every bond.</ContractRow>
              <ContractRow name="TradePassport">The on-chain credit passport — settled-trade history and deposit tiers, written by authorised writers on settlement.</ContractRow>
              <ContractRow name="FinancingPool">The LP vault — advances working capital to sellers, tracks shares, repays on settlement, and holds idle reserves in USYC.</ContractRow>
              <ContractRow name="StakedVerifierModule">Verifier staking, panel draws, vote tally, slashing, and the on-chain attestation that lets a bond settle.</ContractRow>
            </div>
          </Section>

          <Section id="status" title="Status & honesty">
            <P>Bezant is a working MVP on testnet. We&apos;re deliberate about what it is and isn&apos;t:</P>
            <ul className="mt-2 space-y-2 text-fg/90">
              <Bullet>Everything runs on <B>Arc testnet</B> with testnet USDC. Nothing here implies production or regulatory readiness.</Bullet>
              <Bullet>The Trade Officer performs <B>documentary</B> verification — it checks the delivery document, not the physical goods.</Bullet>
              <Bullet>Contracts are unaudited and built for this hackathon; treat balances as demo funds.</Bullet>
            </ul>
            <P className="mt-4">
              Explore the source on{' '}
              <a href="https://github.com/Samuel-Chuku/bezant" target="_blank" rel="noopener" className="text-primary underline hover:text-primary-hover">
                GitHub
              </a>
              , or jump straight in and{' '}
              <Link href="/trade/create" className="text-primary underline hover:text-primary-hover">
                strike a bond
              </Link>
              .
            </P>
          </Section>
        </div>
      </div>
    </main>
  );
}

/* ── local presentational helpers ─────────────────────────────────────────── */

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <h2 className="font-display text-2xl font-semibold tracking-tight text-fg">{title}</h2>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}

function P({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <p className={`max-w-3xl text-sm leading-relaxed text-fg/90 ${className}`}>{children}</p>;
}

function B({ children }: { children: ReactNode }) {
  return <strong className="font-semibold text-fg">{children}</strong>;
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[13px] text-brand">{children}</code>;
}

function Bullet({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-3 text-sm leading-relaxed">
      <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
      <span>{children}</span>
    </li>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 font-mono text-xs font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0">
        <div className="font-semibold text-fg">{title}</div>
        <p className="mt-0.5 max-w-3xl text-sm leading-relaxed text-muted">{children}</p>
      </div>
    </li>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="bz-frame rounded-xl border border-line bg-surface p-5">
      <div className="font-semibold text-fg">{title}</div>
      <p className="mt-2 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}

function ProductRow({ p, children }: { p: string; children: ReactNode }) {
  return (
    <tr className="border-b border-line/60 align-top">
      <td className="whitespace-nowrap py-3 pr-4 font-semibold text-fg">{p}</td>
      <td className="py-3 leading-relaxed">{children}</td>
    </tr>
  );
}

function ContractRow({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="bz-frame rounded-lg border border-line bg-surface px-5 py-4">
      <code className="font-mono text-sm font-semibold text-brand">{name}</code>
      <p className="mt-1 text-sm leading-relaxed text-muted">{children}</p>
    </div>
  );
}
