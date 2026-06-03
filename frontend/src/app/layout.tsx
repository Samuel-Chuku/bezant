import type { Metadata } from 'next';
import './globals.css';
import { Providers } from '@/components/providers';
import { ToastProvider } from '@/components/toast';
import { TopNav } from '@/components/top-nav';
import { SidebarSummary } from '@/components/sidebar-summary';

export const metadata: Metadata = {
  title: 'arc-trade',
  description: 'Agentic commerce on Arc',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <ToastProvider>
            <TopNav />
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
