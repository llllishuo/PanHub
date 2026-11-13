import { useEffect, useState } from 'react';

export type ToastKind = 'info' | 'success' | 'error' | 'warn';
export interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
}

let seq = 0;
let items: ToastItem[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

export function toast(text: string, kind: ToastKind = 'info', ttl = 4200): void {
  const id = ++seq;
  items = [...items, { id, kind, text }];
  emit();
  setTimeout(() => {
    items = items.filter((t) => t.id !== id);
    emit();
  }, ttl);
}

export function toastError(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  toast(msg, 'error', 6500);
}

export function ToastHost() {
  const [list, setList] = useState<ToastItem[]>(items);

  useEffect(() => {
    const l = () => setList(items);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-dot" />
          <span className="toast-text">{t.text}</span>
        </div>
      ))}
    </div>
  );
}
