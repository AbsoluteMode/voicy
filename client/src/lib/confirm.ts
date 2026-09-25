import { useSyncExternalStore } from "react";

/** A question in Voicy's own dialog instead of the WebView's `confirm()`. */
export interface Ask {
  title: string;
  text?: string;
  /** Label of the confirming button. */
  confirm: string;
  /** Destructive: red button and icon. */
  danger?: boolean;
}

type Pending = Ask & { resolve: (yes: boolean) => void };

let pending: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

/** Resolves true when confirmed, false when cancelled or dismissed. */
export function ask(question: Ask): Promise<boolean> {
  pending?.resolve(false);
  return new Promise((resolve) => {
    pending = { ...question, resolve };
    emit();
  });
}

export function answer(yes: boolean) {
  const p = pending;
  pending = null;
  emit();
  p?.resolve(yes);
}

export function usePendingAsk(): Pending | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => pending,
  );
}
