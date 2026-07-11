import type { Metadata } from 'next';
import { headers } from 'next/headers';
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
import { CommandPalette } from '@/components/command-palette';
import { OnboardingTour } from '@/components/onboarding-tour';
import { TourButton } from '@/components/tour-button';
import { FeedbackWidget } from '@/components/feedback-widget';
import { UnifiedBalancePill } from '@/components/unified-balance-pill';

export const metadata: Metadata = {
  metadataBase: new URL('https://bezant.trade'),
  title: {
    default: 'Bezant · stablecoin trade finance',
    // Per-route titles (set in each route's layout) render as "Verify · Bezant".
    template: '%s · Bezant',
  },
  description: 'Trade finance for stablecoins. Escrow that releases on verified delivery.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // On the marketing apex (bezant.trade), "/" is rewritten to the landing, which
  // brings its own chrome — so suppress the app nav/sidebar/footer entirely.
  // The app subdomain, local dev, and Vercel previews render the full app shell.
  const host = ((await headers()).get('host') ?? '').split(':')[0];
  const isMarketing = host === 'bezant.trade' || host === 'www.bezant.trade';
  return (
    <html lang="en" className={`${fraunces.variable} ${bricolage.variable} ${jetbrainsMono.variable}`}>
      <body>
        {/* Fixed background grid + crosshair canvas behind all app content. */}
        <div className="app-canvas" aria-hidden />
        {/* Apply the saved theme before paint. Prefer the cross-subdomain cookie
            (so the app inherits the landing's choice), then localStorage. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var m=document.cookie.match(/bezant-theme=(dark|light)/);var t=m?m[1]:localStorage.getItem('bezant-theme');if(t==='light')document.documentElement.dataset.theme='light';else if(t==='dark')document.documentElement.dataset.theme='dark';}catch(e){}`,
          }}
        />
        <Providers>
          <ToastProvider>
            {isMarketing ? (
              children
            ) : (
              <>
                <TopNav />
                <CommandPalette />
                <ProfileSetupBanner />
                {children}
                <AppFooter />
                {/* SidebarSummary self-positions: fixed + draggable at lg+,
                    inline panel below content under lg. */}
                <SidebarSummary />
                <OnboardingTour />
                <TourButton />
                <FeedbackWidget />
                <UnifiedBalancePill />
              </>
            )}
          </ToastProvider>
        </Providers>
      </body>
    </html>
  );
}
