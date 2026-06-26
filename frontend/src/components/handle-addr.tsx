'use client';

import { useEffect, useState } from 'react';
import { getUserByAddress } from '@/lib/api';
import { arcExplorerAddressUrl } from '@/lib/explorers';

// Module-level cache so a list of cards (or both parties on a detail page)
// resolves each address once, not per render.
const cache = new Map<string, string | null>();

export function useHandle(address?: string | null): string | null {
  const key = address ? address.toLowerCase() : null;
  const [handle, setHandle] = useState<string | null>(key && cache.has(key) ? cache.get(key)! : null);

  useEffect(() => {
    if (!key) return;
    if (cache.has(key)) {
      setHandle(cache.get(key)!);
      return;
    }
    let active = true;
    getUserByAddress(key)
      .then((u) => {
        const h = u?.handle ?? null;
        cache.set(key, h);
        if (active) setHandle(h);
      })
      .catch(() => {
        cache.set(key, null);
      });
    return () => {
      active = false;
    };
  }, [key]);

  return handle;
}

function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

// Renders @handle when known, else the short address. With withAddress, shows
// "@handle (0x12…789)" when a handle is known (just the short address otherwise).
// Links to the explorer unless link={false}; full address in the title on hover.
export function HandleAddr({
  address,
  link = true,
  withAddress = false,
}: {
  address: string;
  link?: boolean;
  withAddress?: boolean;
}) {
  const handle = useHandle(address);
  const inner = handle ? (
    <>
      @{handle}
      {withAddress && <span className="text-muted"> ({short(address)})</span>}
    </>
  ) : (
    short(address)
  );
  if (!link) return <span title={address}>{inner}</span>;
  return (
    <a href={arcExplorerAddressUrl(address)} target="_blank" rel="noreferrer" className="hover:underline" title={address}>
      {inner}
    </a>
  );
}
