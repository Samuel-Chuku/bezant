// Cross-subdomain theme persistence. The marketing landing (bezant.trade) and
// the app (app.bezant.trade) are different origins, so localStorage can't be
// shared between them. A cookie scoped to the registrable domain (.bezant.trade)
// is readable on both, so the app inherits whatever theme the landing last
// showed. Falls back to a plain host-only cookie on localhost / preview hosts.
export type Theme = 'dark' | 'light';

const COOKIE = 'bezant-theme';
const LS_KEY = 'bezant-theme';

function cookieDomainSuffix(): string {
  if (typeof window === 'undefined') return '';
  const host = window.location.hostname;
  return host === 'bezant.trade' || host.endsWith('.bezant.trade')
    ? '; domain=.bezant.trade'
    : '';
}

export function readStoredTheme(): Theme | null {
  if (typeof document === 'undefined') return null;
  const m = document.cookie.match(/(?:^|;\s*)bezant-theme=(dark|light)/);
  if (m) return m[1] as Theme;
  try {
    const ls = localStorage.getItem(LS_KEY);
    if (ls === 'dark' || ls === 'light') return ls;
  } catch {
    /* storage blocked */
  }
  return null;
}

// Persist only - callers update the DOM (the app via <html data-theme>, the
// landing via its own scoped <div data-theme>).
export function persistTheme(theme: Theme): void {
  if (typeof document === 'undefined') return;
  document.cookie = `${COOKIE}=${theme}; path=/; max-age=31536000; samesite=lax${cookieDomainSuffix()}`;
  try {
    localStorage.setItem(LS_KEY, theme);
  } catch {
    /* storage blocked - the cookie still carries it */
  }
}
