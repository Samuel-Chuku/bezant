import type { Metadata } from 'next';
import './globals.css';
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
    <html lang="en">
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
