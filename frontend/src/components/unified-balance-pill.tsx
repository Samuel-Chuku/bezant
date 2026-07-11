'use client';

// Floating unified-balance pill: a persistent, at-a-glance view of the user's
// Circle Gateway balance, linking to the full top-up/withdraw panel on /profile.
// EOA-only (Gateway is EOA-only) and hidden until there's something to show.
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { useSigner } from '@/hooks/use-signer';
import { getUnifiedBalance } from '@/lib/api';

export function UnifiedBalancePill() {
  const signer = useSigner();
  const pathname = usePathname();
  const [total, setTotal] = useState<number | null>(null);

  const isEoa = signer.isConnected && signer.mode === 'external';
  const address = isEoa ? signer.address : undefined;

  useEffect(() => {
    if (!address) { setTotal(null); return; }
    let live = true;
    const fetchBal = () => getUnifiedBalance(address).then((b) => live && setTotal(Number(b.totalUsdc))).catch(() => {});
    fetchBal();
    const t = setInterval(fetchBal, 30_000);
    return () => { live = false; clearInterval(t); };
  }, [address]);

  // Hide on the profile (the full panel is there) and when there's no balance.
  if (!isEoa || total === null || total <= 0 || pathname === '/profile') return null;

  return (
    <Link
      href="/profile"
      title="Your Circle Gateway unified balance — manage on your profile"
      className="fixed bottom-4 left-4 z-30 hidden items-center gap-2 rounded-full border border-line bg-surface/90 px-3 py-2 text-sm shadow-lg backdrop-blur transition hover:border-line-strong sm:inline-flex"
    >
      <span className="inline-block h-2 w-2 rounded-full bg-primary" aria-hidden />
      <span className="font-mono tabular-nums text-fg">{total.toFixed(2)}</span>
      <span className="text-xs text-muted">USDC · unified</span>
    </Link>
  );
}
