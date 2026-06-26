// Single source of truth for "just now / 5m ago / 3h ago / 2d ago" across the
// app. Older than a week falls back to an absolute date.
export function timeAgo(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d ago`;
  return new Date(ms).toLocaleDateString();
}

// SQLite datetime strings are UTC without a zone marker - parse them as UTC.
export function sqlTimeAgo(at: string | null | undefined): string {
  if (!at) return '';
  const ms = new Date(at.includes('Z') || at.includes('T') ? at : at + 'Z').getTime();
  return timeAgo(ms);
}
