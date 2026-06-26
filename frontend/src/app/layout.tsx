import type { Metadata } from 'next';
import { Fraunces } from 'next/font/google';
import './globals.css';

// Brand serif for the "bezant" wordmark. Exposed as the --font-brand CSS var
// (used by Tailwind's font-brand). Only the wordmark uses it; the rest of the
// UI stays on the system sans.
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['500', '600'],
  variable: '--font-brand',
  display: 'swap',
});
import { Providers } from '@/components/providers';
import { ToastProvider } from '@/components/toast';
import { TopNav } from '@/components/top-nav';
import { ProfileSetupBanner } from '@/components/profile-setup-banner';
import { SidebarSummary } from '@/components/sidebar-summary';

export const metadata: Metadata = {
  title: 'Bezant',
  description: 'Trade finance for stablecoins. Escrow that releases on verified delivery.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={fraunces.variable}>
      <body>
        <Providers>
          <ToastProvider>
            <TopNav />
            <ProfileSetupBanner />
            {children}
            {/* SidebarSummary self-positions: fixed + draggable at lg+,
                inline panel below content under lg. */}
            <SidebarSummary />
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
