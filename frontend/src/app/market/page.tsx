import { redirect } from 'next/navigation';

// The standalone Market page was folded into the Pacts hub's "Browse" tab.
// Kept as a redirect so old links / bookmarks still resolve.
export default function MarketRedirect() {
  redirect('/pacts?tab=browse');
}
