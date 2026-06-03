'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type ToastType = 'success' | 'error' | 'info';
type Toast = { id: number; type: ToastType; message: string };

type ToastApi = {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
};

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}

let nextId = 0;
const DURATION_MS = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (type: ToastType, message: string) => {
      const id = nextId++;
      setToasts((list) => [...list, { id, type, message }]);
      setTimeout(() => remove(id), DURATION_MS);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 top-16 z-50 flex w-[calc(100vw-2rem)] max-w-sm flex-col gap-2">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => remove(t.id)} />
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

const TINT: Record<ToastType, { border: string; icon: ReactNode }> = {
  success: {
    border: 'border-emerald-800/60',
    icon: <span className="text-emerald-400">✓</span>,
  },
  error: {
    border: 'border-red-800/60',
    icon: <span className="text-red-400">✕</span>,
  },
  info: {
    border: 'border-neutral-700',
    icon: <span className="text-neutral-300">•</span>,
  },
};

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  // Entrance transition: slide in + fade on mount (transform/opacity only).
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const { border, icon } = TINT[toast.type];
  return (
    <div
      className={`pointer-events-auto flex items-start gap-2 rounded-lg border bg-neutral-900/95 px-3 py-2 text-sm text-neutral-100 shadow-lg backdrop-blur transition-all duration-200 ${border} ${
        shown ? 'translate-x-0 opacity-100' : 'translate-x-3 opacity-0'
      }`}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 break-words">{toast.message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="-mr-1 shrink-0 text-neutral-500 hover:text-neutral-200"
      >
        ✕
      </button>
    </div>
  );
}
