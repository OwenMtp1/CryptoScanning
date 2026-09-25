"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * In-page confirmation / notification dialogs. Native alert/confirm/prompt
 * are not used: they are blocked in sandboxed viewers and easy to click
 * through. Safety-critical actions can require typing a word.
 */
export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  tone?: "danger" | "default";
  /** The user must type this exact word to confirm. */
  requireText?: string;
  /** Free-text input (e.g. a reason), prefilled with this value. */
  input?: string;
}

type Pending = ConfirmOptions & { resolve: (r: { ok: boolean; text: string }) => void };

interface Dialogs {
  confirm: (o: ConfirmOptions) => Promise<{ ok: boolean; text: string }>;
  notify: (message: string, tone?: "error" | "info") => void;
}

const Ctx = createContext<Dialogs>({
  confirm: async () => ({ ok: false, text: "" }),
  notify: () => {},
});

export function useDialogs(): Dialogs {
  return useContext(Ctx);
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [text, setText] = useState("");
  const [toast, setToast] = useState<{ message: string; tone: "error" | "info" } | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const confirm = useCallback(
    (o: ConfirmOptions) =>
      new Promise<{ ok: boolean; text: string }>((resolve) => {
        setText(o.input ?? "");
        setPending({ ...o, resolve });
      }),
    [],
  );
  const notify = useCallback((message: string, tone: "error" | "info" = "info") => setToast({ message, tone }), []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (pending) setTimeout(() => field.current?.focus(), 0);
  }, [pending]);

  const close = (ok: boolean) => {
    if (!pending) return;
    pending.resolve({ ok, text });
    setPending(null);
  };
  const needsText = pending?.requireText !== undefined;
  const canConfirm = !needsText || text === pending?.requireText;

  return (
    <Ctx.Provider value={{ confirm, notify }}>
      {children}
      {pending && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4" role="dialog" aria-modal="true" aria-labelledby="dlg-title" onKeyDown={(e) => e.key === "Escape" && close(false)}>
          <div className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-xl">
            <h2 id="dlg-title" className="text-base font-semibold text-slate-100">
              {pending.title}
            </h2>
            {pending.message && <p className="mt-2 whitespace-pre-line text-sm text-slate-300">{pending.message}</p>}
            {(needsText || pending.input !== undefined) && (
              <label className="mt-4 block text-xs text-slate-400">
                {needsText ? (
                  <>
                    Tape <strong className="font-mono text-slate-100">{pending.requireText}</strong> pour confirmer
                  </>
                ) : (
                  "Raison"
                )}
                <input
                  id="dlg-input"
                  ref={field}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && canConfirm && close(true)}
                  className="mt-1 w-full rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-500"
                />
              </label>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button id="dlg-cancel" onClick={() => close(false)} className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">
                Annuler
              </button>
              <button
                id="dlg-confirm"
                disabled={!canConfirm}
                onClick={() => close(true)}
                className={`rounded px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40 ${pending.tone === "danger" ? "bg-rose-600 hover:bg-rose-500" : "bg-sky-600 hover:bg-sky-500"}`}
              >
                {pending.confirmLabel ?? "Confirmer"}
              </button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div role="status" className={`fixed bottom-4 right-4 z-50 max-w-sm rounded border px-4 py-3 text-sm shadow-lg ${toast.tone === "error" ? "border-rose-800 bg-rose-950 text-rose-100" : "border-slate-700 bg-slate-900 text-slate-100"}`}>
          {toast.message}
        </div>
      )}
    </Ctx.Provider>
  );
}
