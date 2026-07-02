import { NextResponse, type NextRequest } from 'next/server';

// Host-based split:
//   bezant.trade / www.bezant.trade  (apex) → marketing. "/" serves the landing;
//                                              any deeper path bounces to the app.
//   app.bezant.trade / localhost / *.vercel.app → the app, served untouched.
//
// The apex and the app are the SAME Vercel deployment; only the hostname differs.
const APEX_HOSTS = new Set(['bezant.trade', 'www.bezant.trade']);
const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.bezant.trade';

export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').split(':')[0];
  if (!APEX_HOSTS.has(host)) return NextResponse.next();

  const url = req.nextUrl;
  // Bare apex → render the landing without changing the URL bar.
  if (url.pathname === '/') {
    return NextResponse.rewrite(new URL('/landing', req.url));
  }
  // A real app route requested on the apex → the app lives on its own subdomain.
  return NextResponse.redirect(new URL(`${APP_ORIGIN}${url.pathname}${url.search}`));
}

export const config = {
  // Run on everything except Next internals and files with an extension
  // (favicon, og-image, /_next/*, etc.).
  matcher: ['/((?!_next/|.*\\..*).*)'],
};
