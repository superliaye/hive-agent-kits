// Transient toast system (#50). A page-local hook + container that acknowledges
// silent mutations (sync, Source activate/deactivate/delete) with a brief,
// non-blocking, dismissible toast. Presentational only — the toast type is a
// small local discriminated union; no wire schema (nothing crosses HTTP). The
// host carries an aria-live region (polite for success/info, the error toast
// also role="alert") so the feedback is announced without stealing focus.

import { useCallback, useEffect, useRef, useState } from "react";

export type ToastKind = "success" | "error" | "info";

export type Toast = {
  id: number;
  kind: ToastKind;
  message: string;
};

// Auto-dismiss window. Long enough to read a one-line acknowledgement, short
// enough to stay transient.
const AUTO_DISMISS_MS = 4000;

export type UseToasts = {
  toasts: Toast[];
  // Push a toast; returns its id. Schedules its own auto-dismiss.
  push: (kind: ToastKind, message: string) => number;
  dismiss: (id: number) => void;
};

export function useToasts(): UseToasts {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  // Live auto-dismiss timers, so dismiss() (and unmount) can clear them and we
  // never fire a setState on an unmounted/already-removed toast.
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string): number => {
      const id = nextId.current++;
      setToasts((cur) => [...cur, { id, kind, message }]);
      const timer = window.setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      timers.current.set(id, timer);
      return id;
    },
    [dismiss],
  );

  // Clear every pending timer on unmount.
  useEffect(() => {
    const live = timers.current;
    return () => {
      for (const timer of live.values()) window.clearTimeout(timer);
      live.clear();
    };
  }, []);

  return { toasts, push, dismiss };
}

const ROLE: Record<ToastKind, "alert" | "status"> = {
  error: "alert",
  success: "status",
  info: "status",
};

// Fixed-position, non-blocking overlay (`pointer-events:none` on the host so it
// never traps clicks; each toast re-enables its own). Stacked, corner-anchored.
// `aria-live="polite"` announces success/info without interrupting; the error
// toast's own `role="alert"` raises its urgency.
export function ToastHost({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}): JSX.Element {
  return (
    <div className="toast-host" data-testid="toast-host" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          role={ROLE[t.kind]}
          data-testid="toast"
          data-toast-kind={t.kind}
        >
          <span className="toast-message" data-testid={`toast-${t.kind}`}>
            {t.message}
          </span>
          <button
            type="button"
            className="toast-dismiss"
            onClick={() => onDismiss(t.id)}
            aria-label="Dismiss"
            data-testid={`toast-dismiss-${t.id}`}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
