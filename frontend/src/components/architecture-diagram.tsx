// Bezant system architecture — a presentation-grade, theme-aware SVG used on the
// /docs page and mirrored in the submission PDF. Colours are driven by the Ink &
// Mint design tokens (rgb(var(--token))) so it tracks light/dark automatically.
// Layers, top to bottom: actors → app → backend → contracts on Arc → Circle stack.

type BoxProps = {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  accent?: 'line' | 'primary' | 'brand';
  fill?: string;
};

const ACCENT: Record<NonNullable<BoxProps['accent']>, string> = {
  line: 'rgb(var(--line-strong))',
  primary: 'rgb(var(--primary))',
  brand: 'rgb(var(--brand))',
};

function Box({ x, y, w, h, title, sub, accent = 'line', fill = 'rgb(var(--surface))' }: BoxProps) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} style={{ fill, stroke: ACCENT[accent] }} strokeWidth={1.25} />
      <text
        x={x + w / 2}
        y={sub ? y + h / 2 - 5 : y + h / 2 + 4}
        textAnchor="middle"
        style={{ fill: 'rgb(var(--fg))', fontFamily: 'var(--font-sans)', fontWeight: 600 }}
        fontSize={14}
      >
        {title}
      </text>
      {sub && (
        <text
          x={x + w / 2}
          y={y + h / 2 + 13}
          textAnchor="middle"
          style={{ fill: 'rgb(var(--muted))', fontFamily: 'var(--font-mono)' }}
          fontSize={10.5}
        >
          {sub}
        </text>
      )}
    </g>
  );
}

function LayerLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text x={x} y={y} style={{ fill: 'rgb(var(--muted))', fontFamily: 'var(--font-mono)', letterSpacing: '0.14em' }} fontSize={10}>
      {children.toUpperCase()}
    </text>
  );
}

// Vertical connector with an arrowhead, mint-tinted.
function Flow({ x, y1, y2 }: { x: number; y1: number; y2: number }) {
  return <line x1={x} y1={y1} x2={x} y2={y2} style={{ stroke: 'rgb(var(--primary))' }} strokeWidth={1.5} markerEnd="url(#bz-arrow)" opacity={0.7} />;
}

export function ArchitectureDiagram({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 980 700" role="img" aria-label="Bezant system architecture" className={className} style={{ width: '100%', height: 'auto' }}>
      <defs>
        <marker id="bz-arrow" markerWidth="9" markerHeight="9" refX="4.5" refY="4.5" orient="auto">
          <path d="M1 1 L8 4.5 L1 8" fill="none" style={{ stroke: 'rgb(var(--primary))' }} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" />
        </marker>
      </defs>

      {/* ── Actors ───────────────────────────────────────────── */}
      <LayerLabel x={24} y={22}>Participants</LayerLabel>
      <Box x={24} y={34} w={210} h={54} title="Buyer" sub="strikes & funds the bond" />
      <Box x={256} y={34} w={210} h={54} title="Seller" sub="delivers · draws advance" />
      <Box x={488} y={34} w={220} h={54} title="Verifier" sub="stakes · votes on delivery" />
      <Box x={730} y={34} w={226} h={54} title="Liquidity provider" sub="funds the pool · earns fees" />

      <Flow x={490} y1={92} y2={128} />

      {/* ── Frontend ─────────────────────────────────────────── */}
      <LayerLabel x={24} y={122}>Client</LayerLabel>
      <Box
        x={24}
        y={134}
        w={932}
        h={72}
        title="Bezant web app — Next.js 15 (App Router) on Vercel"
        sub="SIWE sign-in · Circle Wallets onboarding · unified-balance funding · bond lifecycle UI"
        accent="primary"
        fill="rgb(var(--surface-2))"
      />

      <Flow x={490} y1={210} y2={246} />

      {/* ── Backend ──────────────────────────────────────────── */}
      <LayerLabel x={24} y={240}>Backend · off-chain services</LayerLabel>
      <rect x={24} y={252} width={932} height={104} rx={12} style={{ fill: 'rgb(var(--surface))', stroke: 'rgb(var(--line-strong))' }} strokeWidth={1.25} />
      <text x={40} y={272} style={{ fill: 'rgb(var(--muted))', fontFamily: 'var(--font-mono)' }} fontSize={10.5}>
        Fastify API · SQLite
      </text>
      <Box x={40} y={282} w={210} h={58} title="Chain indexer" sub="events → bond state" fill="rgb(var(--surface-2))" />
      <Box x={266} y={282} w={210} h={58} title="Trade Officer" sub="AI document examiner" accent="brand" fill="rgb(var(--surface-2))" />
      <Box x={492} y={282} w={210} h={58} title="Verifier panels" sub="draw · tally · attest" fill="rgb(var(--surface-2))" />
      <Box x={718} y={282} w={222} h={58} title="Notifications" sub="Telegram alerts" fill="rgb(var(--surface-2))" />

      <Flow x={490} y1={360} y2={398} />

      {/* ── Contracts ────────────────────────────────────────── */}
      <LayerLabel x={24} y={392}>Smart contracts · Arc L1 (USDC-native)</LayerLabel>
      <rect x={24} y={404} width={932} height={104} rx={12} style={{ fill: 'rgb(var(--surface))', stroke: ACCENT.brand }} strokeWidth={1.25} />
      <Box x={40} y={430} w={214} h={62} title="TradeEscrow" sub="fund · settle · refund" accent="brand" fill="rgb(var(--surface-2))" />
      <Box x={270} y={430} w={214} h={62} title="TradePassport" sub="on-chain credit history" accent="brand" fill="rgb(var(--surface-2))" />
      <Box x={500} y={430} w={214} h={62} title="FinancingPool" sub="advances · LP shares" accent="brand" fill="rgb(var(--surface-2))" />
      <Box x={726} y={430} w={214} h={62} title="StakedVerifierModule" sub="stake · slash · attest" accent="brand" fill="rgb(var(--surface-2))" />

      <Flow x={490} y1={512} y2={550} />

      {/* ── Circle stack ─────────────────────────────────────── */}
      <LayerLabel x={24} y={544}>Circle stack</LayerLabel>
      <rect x={24} y={556} width={932} height={90} rx={12} style={{ fill: 'rgb(var(--primary) / 0.08)', stroke: 'rgb(var(--primary))' }} strokeWidth={1.25} />
      {[
        { t: 'USDC', s: 'settlement + gas' },
        { t: 'Circle Wallets', s: 'onboarding' },
        { t: 'Gateway', s: 'unified balance' },
        { t: 'CCTP / Bridge Kit', s: 'cross-chain' },
        { t: 'USYC', s: 'idle-liquidity yield' },
      ].map((c, i) => {
        const cw = 176;
        const gap = 8;
        const startX = 40;
        const x = startX + i * (cw + gap);
        return <Box key={c.t} x={x} y={578} w={cw} h={46} title={c.t} sub={c.s} accent="primary" fill="rgb(var(--surface))" />;
      })}

      {/* Footnote band */}
      <text x={490} y={678} textAnchor="middle" style={{ fill: 'rgb(var(--muted))', fontFamily: 'var(--font-mono)' }} fontSize={10}>
        Chain indexer reads Arc events · Trade Officer &amp; panels write attestations · every settlement updates both passports
      </text>
    </svg>
  );
}
