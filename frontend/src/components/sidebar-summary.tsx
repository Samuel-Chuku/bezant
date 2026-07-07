'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Address } from 'viem';
import { useBalance } from 'wagmi';
import { useSigner } from '@/hooks/use-signer';
import { arcTestnet } from '@/lib/chains';
import { BRIDGE_SOURCES, type BridgeSource } from '@/lib/bridge';
import { truncateBalance } from '@/lib/format';
import { BridgeIcon } from '@/components/bridge-icon';

const WIDGET_WIDTH = 320;
const POS_KEY = 'arc-trade:sidebar-pos';
const COLLAPSE_KEY = 'arc-trade:sidebar-collapsed';
const PILL_W = 132;
const LG_MIN = 1024;
const NAV_HEIGHT = 56;

type Pos = { x: number; y: number };

// Right-margin balances tile. On /bridge it shows Arc + the 4 source chains
// so you can watch funds move between chains. Everywhere else it shows just
// Arc - this is an Arc app, the rest is bridge-only context.
//
// At lg+ the widget is fixed-positioned and draggable by its handle; the
// position is persisted to localStorage. Below lg it falls back to an
// inline panel under the page content.
export function SidebarSummary() {
  const pathname = usePathname();
  const signer = useSigner();
  // The /bridge page renders its own larger, static balances panel inline -
  // suppress the floating widget there so they don't double up.
  const onBridgePage = pathname?.startsWith('/bridge') ?? false;
  const showSources = onBridgePage;

  const [pos, setPos] = useState<Pos | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<
    | { startClientX: number; startClientY: number; baseX: number; baseY: number }
    | null
  >(null);

  // Hydrate position + collapsed state on first client render. SSR has no
  // window so we can't compute a default; render with no inline style until ready.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPos(loadPosition() ?? defaultPosition());
    setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
  }, []);

  const setCollapsedPersist = (v: boolean) => {
    setCollapsed(v);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0');
    } catch {
      // ignored
    }
  };

  // Keep the widget inside the viewport if the window is resized.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onResize = () => {
      setPos((p) => (p ? clampToViewport(p) : p));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (typeof window === 'undefined' || window.innerWidth < LG_MIN) return;
      const current = pos ?? defaultPosition();
      dragRef.current = {
        startClientX: e.clientX,
        startClientY: e.clientY,
        baseX: current.x,
        baseY: current.y,
      };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      setDragging(true);
    },
    [pos],
  );

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const next = clampToViewport({
      x: d.baseX + (e.clientX - d.startClientX),
      y: d.baseY + (e.clientY - d.startClientY),
    });
    setPos(next);
  }, []);

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
      if (pos) savePosition(pos);
      setDragging(false);
    },
    [pos],
  );

  if (!signer.isConnected) return null;
  if (onBridgePage) return null;
  if (pathname === '/landing') return null; // marketing landing has its own chrome

  // Nearest horizontal edge, so a collapsed widget tucks to whichever side
  // it's closest to.
  const side: 'left' | 'right' =
    pos && typeof window !== 'undefined' && pos.x + WIDGET_WIDTH / 2 > window.innerWidth / 2
      ? 'right'
      : 'left';

  // Inline style only takes effect when `position: fixed` is active (lg+).
  // Below lg the static layout ignores left/top and the widget renders
  // inline via the wrapping classes. When collapsed it docks to `side`.
  const inlineStyle: React.CSSProperties | undefined = pos
    ? collapsed
      ? {
          top: `${pos.y}px`,
          width: `${PILL_W}px`,
          left: side === 'left' ? 0 : undefined,
          right: side === 'right' ? 0 : undefined,
        }
      : { left: `${pos.x}px`, top: `${pos.y}px`, width: `${WIDGET_WIDTH}px` }
    : undefined;

  return (
    <div
      className={`mx-auto mb-12 mt-4 max-w-md px-6 lg:fixed lg:m-0 lg:max-w-none lg:p-0 lg:z-30 ${
        dragging ? '' : 'lg:transition-all lg:duration-300 lg:ease-out'
      } ${collapsed ? 'max-w-[132px]' : ''}`}
      style={inlineStyle}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsedPersist(false)}
          aria-label="Show balances"
          title="Show balances"
          className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-line bg-surface/70 px-3 py-2.5 text-xs font-medium text-fg shadow-lg backdrop-blur transition hover:bg-surface"
        >
          <WalletGlyph />
          USDC
          <EdgeChevron dir={side === 'right' ? 'left' : 'right'} />
        </button>
      ) : (
        <aside className="rounded-2xl border border-line bg-surface/40 p-5 shadow-lg">
          {/* Drag handle - visible only at lg+ where the widget is fixed. */}
          <div
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className="-mt-2 mb-1 hidden cursor-grab select-none items-center justify-center pb-1 active:cursor-grabbing lg:flex"
            aria-label="Drag to move"
            title="Drag to move"
          >
            <span className="text-muted" aria-hidden>
              <svg width="22" height="6" viewBox="0 0 22 6" fill="currentColor">
                <circle cx="3" cy="3" r="1.5" />
                <circle cx="11" cy="3" r="1.5" />
                <circle cx="19" cy="3" r="1.5" />
              </svg>
            </span>
          </div>

          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-fg">Your USDC</h2>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={() => setCollapsedPersist(true)}
                aria-label="Hide balances"
                title="Hide"
                className="-my-1 inline-flex items-center text-muted transition hover:text-fg"
              >
                <EdgeChevron dir={side} />
              </button>
            </div>
          </div>
          <p className="mt-1 text-[11px] text-muted">
            {showSources
              ? 'Live balances on Arc and supported CCTP testnets.'
              : 'Live Arc balance for this wallet.'}
          </p>

          <ul className="mt-4 space-y-1.5">
            <BalanceRow
              label="Arc Testnet"
              sublabel={showSources ? 'destination' : 'this app'}
              accent="emerald"
              address={signer.address}
              chainId={arcTestnet.id}
            />
            {showSources &&
              BRIDGE_SOURCES.map((source) => (
                <SourceBalanceRow key={source.key} source={source} address={signer.address} />
              ))}
          </ul>

          <Link
            href="/bridge"
            className="mt-4 flex items-start gap-2 rounded-xl border border-primary/25 bg-primary/10 px-3 py-2.5 text-[11px] leading-snug text-primary transition hover:bg-primary/20"
          >
            <span className="flex-1">Have USDC on other chains? Bring them to Arc to trade seamlessly on Bezant.</span>
            <BridgeIcon className="mt-px h-4 w-4 flex-shrink-0" />
          </Link>
        </aside>
      )}
    </div>
  );
}

function WalletGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18M16 14h.01" />
    </svg>
  );
}

// Chevron pointing right by default; flipped for left. Used to indicate the
// dock direction (hide) and the expand direction (restore pill).
function EdgeChevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={dir === 'left' ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function SourceBalanceRow({ source, address }: { source: BridgeSource; address: Address }) {
  // BRIDGE_SOURCES filters out chains without a wagmi id, so this is always
  // defined at runtime. Narrow the type for the BalanceRow contract.
  if (source.wagmiChainId === undefined) return null;
  return (
    <BalanceRow
      label={source.fullName}
      sublabel={`CCTP domain ${source.cctpDomain}`}
      address={address}
      chainId={source.wagmiChainId}
      token={source.usdc}
    />
  );
}

function BalanceRow({
  label,
  sublabel,
  address,
  chainId,
  token,
  accent,
}: {
  label: string;
  sublabel: string;
  address: Address;
  chainId: number;
  token?: Address;
  accent?: 'emerald';
}) {
  // Poll so balances update post-bridge / post-fund without a manual reload.
  const { data, isLoading } = useBalance({
    address,
    chainId,
    token,
    query: { refetchInterval: 15_000 },
  });
  const formatted = isLoading ? '…' : data ? truncateBalance(data.formatted, 2) : '0';
  const has = !!data && Number(data.formatted) > 0;

  return (
    <li className="flex items-center justify-between rounded-md px-2 py-1.5 text-xs hover:bg-surface/60">
      <div className="min-w-0">
        <div
          className={`truncate ${accent === 'emerald' ? 'text-primary' : 'text-fg'}`}
        >
          {label}
        </div>
        <div className="text-[10px] text-muted">{sublabel}</div>
      </div>
      <div className={`font-mono text-xs ${has ? 'text-fg' : 'text-muted'}`}>
        {formatted} <span className="text-muted">USDC</span>
      </div>
    </li>
  );
}

function loadPosition(): Pos | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
      return clampToViewport(parsed);
    }
  } catch {
    // ignored
  }
  return null;
}

function savePosition(pos: Pos): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {
    // ignored
  }
}

function defaultPosition(): Pos {
  if (typeof window === 'undefined') return { x: 0, y: NAV_HEIGHT + 24 };
  return clampToViewport({
    x: window.innerWidth - WIDGET_WIDTH - 24,
    y: NAV_HEIGHT + 24,
  });
}

function clampToViewport(p: Pos): Pos {
  if (typeof window === 'undefined') return p;
  // Keep at least a sliver visible on every edge - never let the widget
  // disappear off-screen.
  const maxX = Math.max(0, window.innerWidth - WIDGET_WIDTH);
  const maxY = Math.max(NAV_HEIGHT, window.innerHeight - 80);
  return {
    x: Math.max(0, Math.min(p.x, maxX)),
    y: Math.max(NAV_HEIGHT, Math.min(p.y, maxY)),
  };
}
