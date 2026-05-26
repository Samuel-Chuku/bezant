// Brand SVG marks for the bridge source chains + Arc destination. Inline so
// no asset pipeline is needed; props let callers size them anywhere.
import type { BridgeSource } from '@/lib/bridge';

type Props = { className?: string };

export function EthereumLogo({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff" fillRule="nonzero">
        <path fillOpacity=".6" d="M16.498 4v8.87l7.497 3.35z" />
        <path d="M16.498 4 9 16.22l7.498-3.35z" />
        <path fillOpacity=".6" d="M16.498 21.968v6.027L24 17.616z" />
        <path d="M16.498 27.995v-6.028L9 17.616z" />
        <path fillOpacity=".2" d="m16.498 20.573 7.497-4.353-7.497-3.348z" />
        <path fillOpacity=".6" d="M9 16.22l7.498 4.353v-7.701z" />
      </g>
    </svg>
  );
}

export function OptimismLogo({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <circle cx="16" cy="16" r="16" fill="#FF0420" />
      <path
        fill="#fff"
        d="M11.85 19.9c-1.07 0-1.94-.25-2.62-.76-.67-.51-1-1.24-1-2.2 0-.2.02-.44.07-.73.12-.66.3-1.45.52-2.37.64-2.59 2.3-3.88 4.97-3.88.73 0 1.38.12 1.95.36.58.24 1.03.6 1.36 1.07.33.48.5 1.05.5 1.7 0 .2-.03.44-.08.7-.14.81-.31 1.6-.51 2.37-.33 1.29-.9 2.25-1.71 2.89-.82.64-1.97.95-3.45.95Zm.2-2.04c.58 0 1.06-.17 1.46-.51.41-.34.7-.86.87-1.57.21-.86.37-1.6.48-2.24.04-.19.06-.38.06-.58 0-.81-.42-1.21-1.27-1.21-.58 0-1.07.17-1.48.51-.4.34-.69.86-.86 1.57a39 39 0 0 0-.48 2.24c-.04.18-.06.37-.06.56 0 .82.43 1.23 1.28 1.23Zm6.43 1.93a.25.25 0 0 1-.2-.09.27.27 0 0 1-.04-.22l1.84-8.7a.32.32 0 0 1 .12-.21c.06-.05.13-.07.21-.07h3.55c.99 0 1.78.21 2.37.62.6.41.9 1.01.9 1.79 0 .22-.03.46-.08.71-.22 1.03-.67 1.79-1.34 2.28-.66.49-1.57.74-2.73.74h-1.8l-.62 2.84a.32.32 0 0 1-.12.21c-.06.05-.13.07-.21.07h-1.85Zm4.6-5.13c.37 0 .69-.1.96-.31.28-.21.46-.5.55-.89.03-.15.05-.29.05-.4 0-.27-.08-.47-.23-.61-.16-.15-.43-.22-.81-.22h-1.6l-.52 2.43z"
      />
    </svg>
  );
}

export function ArbitrumLogo({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <circle cx="16" cy="16" r="16" fill="#2D374B" />
      <path
        d="M17.7 13.4l1.5 4-2.6 4.3-3.8-5.8 1.7-2.7c.1-.1.2-.1.4-.1l2.8.3z"
        fill="#28A0F0"
      />
      <path
        d="m19.6 19.1 2.5-4 1.9 3-3.5 5.4-4-2.5z"
        fill="#28A0F0"
      />
      <path
        d="M8 16l4.6-7.3c.1-.2.3-.3.5-.3l5.3.1-9 14.4-1.4-.8a.7.7 0 0 1-.3-.6V16.4c0-.1 0-.3.1-.4Z"
        fill="#fff"
      />
      <path
        d="m18.4 8.4 6.3.1-7.5 12-2.7-1.7-1.2-1.8z"
        fill="#fff"
      />
      <path
        d="M24 21.8V11.7a.7.7 0 0 0-.3-.5L16 6.9a.6.6 0 0 0-.6 0l-7.6 4.3c-.2.1-.3.3-.3.5v8.6c0 .2.1.4.3.5l2 1.2 7.4-12.1c.1-.1.3-.2.4-.2l2.2.1c.2 0 .3.2.2.3l-7.3 11.8 3.3 2 .9-1.4 2.7 1.6.6.4c.2.1.5 0 .6-.1l3.1-1.9c.1-.1.2-.3.2-.4z"
        fill="none"
      />
    </svg>
  );
}

export function BaseLogo({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <circle cx="16" cy="16" r="16" fill="#0052FF" />
      <path
        fill="#fff"
        d="M15.97 25.5c5.25 0 9.5-4.25 9.5-9.5s-4.25-9.5-9.5-9.5C11 6.5 6.91 10.3 6.5 15.13h12.57v1.74H6.5c.41 4.83 4.5 8.63 9.47 8.63Z"
      />
    </svg>
  );
}

export function ArcChainBadge({ className }: Props) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden focusable="false">
      <circle cx="16" cy="16" r="16" fill="#10B981" />
      <path
        d="M10 22 16 8l6 14h-2.5l-1.2-3h-4.6l-1.2 3H10Zm4.4-4.9h3.2L16 13.2l-1.6 3.9Z"
        fill="#fff"
      />
    </svg>
  );
}

export function ChainLogo({
  sourceKey,
  className,
}: {
  sourceKey: BridgeSource['key'];
  className?: string;
}) {
  switch (sourceKey) {
    case 'sepolia':
      return <EthereumLogo className={className} />;
    case 'optimismSepolia':
      return <OptimismLogo className={className} />;
    case 'arbitrumSepolia':
      return <ArbitrumLogo className={className} />;
    case 'baseSepolia':
      return <BaseLogo className={className} />;
    case 'arcTestnet':
      return <ArcChainBadge className={className} />;
  }
}
