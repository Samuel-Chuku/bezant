import type { Metadata } from 'next';
import { Fraunces, Bricolage_Grotesque, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// The Bezant type trio (design system "Ink & Mint"):
// Fraunces  - brand serif: wordmark, display, headings (--font-brand / --font-display)
// Bricolage - body + UI (--font-body)
// JetBrains Mono - all data: USDC amounts, addresses, hashes (--font-mono, tabular)
const fraunces = Fraunces({
  subsets: ['latin'],
  axes: ['opsz'], // variable wght + opsz, so display type can use the high optical size
  variable: '--font-brand',
  display: 'swap',
});
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-body',
  display: 'swap',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
  display: 'swap',
});
import { Providers } from '@/components/providers';
import { ToastProvider } from '@/components/toast';
import { TopNav } from '@/components/top-nav';
import { ProfileSetupBanner } from '@/components/profile-setup-banner';
import { SidebarSummary } from '@/components/sidebar-summary';
import { AppFooter } from '@/components/app-footer';

export const metadata: Metadata = {
  metadataBase: new URL('https://bezant.trade'),
  title: {
    default: 'Bezant · stablecoin trade finance',
    // Per-route titles (set in each route's layout) render as "Verify · Bezant".
    template: '%s · Bezant',
  },
  description: 'Trade finance for stablecoins. Escrow that releases on verified delivery.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${bricolage.variable} ${jetbrainsMono.variable}`}>
      <body>
        {/* Fixed background grid + crosshair canvas behind all app content. */}
        <div className="app-canvas" aria-hidden />
        {/* Apply the saved theme before paint (dark is default, so only light needs setting). */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{if(localStorage.getItem('bezant-theme')==='light')document.documentElement.dataset.theme='light';}catch(e){}`,
          }}
        />
        <Providers>
          <ToastProvider>
            <TopNav />
            <ProfileSetupBanner />
            {children}
            <AppFooter />
            {/* SidebarSummary self-positions: fixed + draggable at lg+,
                inline panel below content under lg. */}
            <SidebarSummary />
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
