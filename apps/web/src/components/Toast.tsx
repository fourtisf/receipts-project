'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export type ToastTone = 'info' | 'ok' | 'error';
export interface ToastInput {
  message: string;
  tone?: ToastTone;
  /** Optional link (e.g. the transaction on Blockscout). */
  href?: string;
  linkLabel?: string;
  /** ms; errors stay longer by default. 0 = until replaced. */
  duration?: number;
}

const Ctx = createContext<(t: ToastInput | string) => void>(() => undefined);

/** One toast at a time, bottom centre (prototype `.toast`). Slides in; reduced motion disables the slide. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<(ToastInput & { id: number }) | null>(null);
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const seq = useRef(0);

  const show = useCallback((t: ToastInput | string) => {
    const input = typeof t === 'string' ? { message: t } : t;
    seq.current += 1;
    setToast({ ...input, id: seq.current });
    setVisible(true);
    clearTimeout(timer.current);
    const ms = input.duration ?? (input.tone === 'error' ? 8000 : 4000);
    if (ms > 0) timer.current = setTimeout(() => setVisible(false), ms);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <Ctx.Provider value={show}>
      {children}
      <div
        className={`toast${visible ? ' show' : ''}${toast?.tone === 'error' ? ' err' : ''}`}
        role={toast?.tone === 'error' ? 'alert' : 'status'}
        aria-live={toast?.tone === 'error' ? 'assertive' : 'polite'}
      >
        {toast ? (
          <>
            <span>{toast.message}</span>
            {toast.href ? (
              <>
                {' '}
                <a href={toast.href} target="_blank" rel="noopener noreferrer">
                  {toast.linkLabel ?? 'View on Blockscout'}
                </a>
              </>
            ) : null}
            <button type="button" aria-label="Dismiss" onClick={() => setVisible(false)}>
              ×
            </button>
          </>
        ) : null}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
