'use client';

// Horizontal lifecycle tracker for a bond. Happy path:
//   Proposed → Struck → Funded → Attested → Settled
// Terminal alternates (Contested / Refunded / Cancelled) show how far the bond
// got, then a single coloured outcome node instead of the remaining steps.

const HAPPY = ['Proposed', 'Struck', 'Funded', 'Attested', 'Settled'] as const;

type Alt = { label: string; tone: 'red' | 'amber' | 'neutral' } | null;

export function TradeStatusTracker({ status, isPanelTrade }: { status: string; isPanelTrade?: boolean }) {
  const labels: string[] = [...HAPPY];
  labels[3] = isPanelTrade ? 'Panel' : 'Attested';

  let reached = 0; // happy steps fully complete
  let active = -1; // index currently in progress (happy path only)
  let alt: Alt = null;
  switch (status) {
    case 'Proposing': active = 0; break;
    case 'Agreed': reached = 1; active = 1; break;
    case 'Funded': reached = 3; active = 3; break; // funded done, verification active
    case 'Released': reached = 5; break;
    case 'Disputed': reached = 3; alt = { label: 'Contested', tone: 'red' }; break;
    case 'Refunded': reached = 3; alt = { label: 'Refunded', tone: 'amber' }; break;
    case 'Cancelled': reached = 1; alt = { label: 'Cancelled', tone: 'neutral' }; break;
  }

  // Build the node list: done steps, then either the alt outcome or the rest of
  // the happy path with its active/todo states.
  type Node = { label: string; state: 'done' | 'active' | 'todo' | 'red' | 'amber' | 'neutral' };
  const nodes: Node[] = alt
    ? [...labels.slice(0, reached).map((label) => ({ label, state: 'done' as const })), { label: alt.label, state: alt.tone }]
    : labels.map((label, i) => ({ label, state: i < reached ? 'done' : i === active ? 'active' : 'todo' }));

  const dot: Record<Node['state'], string> = {
    done: 'bg-primary border-primary',
    active: 'border-brand bg-brand/20 ring-2 ring-brand/30',
    todo: 'border-line-strong bg-surface',
    red: 'bg-danger border-danger',
    amber: 'bg-warn border-warn',
    neutral: 'bg-muted border-line-strong',
  };
  const text: Record<Node['state'], string> = {
    done: 'text-primary',
    active: 'text-brand',
    todo: 'text-muted',
    red: 'text-danger',
    amber: 'text-warn',
    neutral: 'text-muted',
  };

  return (
    <ol className="flex items-center">
      {nodes.map((n, i) => (
        <li key={`${n.label}-${i}`} className={`flex items-center ${i < nodes.length - 1 ? 'flex-1' : ''}`}>
          <div className="flex flex-col items-center gap-1.5">
            <span className={`flex h-5 w-5 items-center justify-center rounded-full border ${dot[n.state]}`}>
              {n.state === 'done' && <Check />}
            </span>
            <span className={`whitespace-nowrap text-[11px] ${text[n.state]}`}>{n.label}</span>
          </div>
          {i < nodes.length - 1 && (
            <span className={`mx-2 mb-5 h-px flex-1 ${n.state === 'done' ? 'bg-primary' : 'bg-surface-2'}`} />
          )}
        </li>
      ))}
    </ol>
  );
}

function Check() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
