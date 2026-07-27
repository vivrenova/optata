import { createContext, useCallback, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

import { cn } from "../../lib/cn";

type Tone = "info" | "danger";

interface ToastItem {
  id: number;
  message: string;
  tone: Tone;
}

const ToastContext = createContext<((message: string, tone?: Tone) => void) | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback((message: string, tone: Tone = "info") => {
    const id = nextId.current++;
    setItems((current) => [...current, { id, message, tone }]);
    setTimeout(() => {
      setItems((current) => current.filter((item) => item.id !== id));
    }, 4500);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              "w-full max-w-sm rounded-tag border-2 border-ink px-4 py-2.5 text-sm shadow-tag",
              item.tone === "danger" ? "bg-danger text-paper" : "bg-paper text-ink",
            )}
          >
            {item.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const toast = useContext(ToastContext);
  if (toast === null) throw new Error("useToast must be used inside ToastProvider");
  return toast;
}
