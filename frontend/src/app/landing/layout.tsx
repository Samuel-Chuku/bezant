import type { Metadata } from 'next';

// Marketing front. `absolute` opts out of the "%s · Bezant" template so the tab
// reads the brand line, not "Landing · Bezant".
export const metadata: Metadata = {
  title: { absolute: 'Bezant · stablecoin trade finance' },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
