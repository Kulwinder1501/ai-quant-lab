"use client";

import React, { createContext, useContext, useState, useCallback, useEffect } from "react";

export type ToastVariant = "success" | "error" | "warning" | "info";

export interface ToastOptions {
  id?: string;
  title: string;
  description?: string;
  variant?: ToastVariant;
  duration?: number;
}

export interface ToastContextType {
  toast: (options: Omit<ToastOptions, "id">) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

const MAX_TOASTS = 5;
const DEFAULT_DURATION = 4000;

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastOptions[]>([]);

  const toast = useCallback(
    ({ title, description, variant = "info", duration = DEFAULT_DURATION }: Omit<ToastOptions, "id">) => {
      const id = Math.random().toString(36).substring(2, 9);
      setToasts((prev) => {
        const newToasts = [...prev, { id, title, description, variant, duration }];
        if (newToasts.length > MAX_TOASTS) {
          return newToasts.slice(newToasts.length - MAX_TOASTS);
        }
        return newToasts;
      });
    },
    []
  );

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-0 right-0 z-50 m-6 flex flex-col gap-3 md:max-w-[420px]">
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onRemove={() => removeToast(t.id!)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onRemove }: { toast: ToastOptions; onRemove: () => void }) {
  const [isLeaving, setIsLeaving] = useState(false);

  useEffect(() => {
    if (toast.duration !== Infinity) {
      const timer = setTimeout(() => {
        handleRemove();
      }, toast.duration);
      return () => clearTimeout(timer);
    }
  }, [toast.duration]);

  const handleRemove = () => {
    setIsLeaving(true);
    setTimeout(() => {
      onRemove();
    }, 300); // Wait for exit animation
  };

  const variants = {
    success: "border-emerald-500",
    error: "border-rose-500",
    warning: "border-amber-500",
    info: "border-cyan-500",
  };

  const icons = {
    success: (
      <svg className="h-5 w-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
      </svg>
    ),
    error: (
      <svg className="h-5 w-5 text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    ),
    warning: (
      <svg className="h-5 w-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    ),
    info: (
      <svg className="h-5 w-5 text-cyan-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  };

  return (
    <div
      className={`relative flex w-full items-start gap-4 rounded-xl border border-slate-700/70 border-l-4 bg-slate-950/80 p-4 shadow-[0_18px_60px_-15px_rgba(0,0,0,0.5)] backdrop-blur-xl transition-all duration-300 ease-in-out motion-reduce:transition-none
      ${variants[toast.variant || "info"]}
      ${isLeaving ? "translate-x-full opacity-0" : "animate-in slide-in-from-right sm:slide-in-from-bottom-full"}
      `}
    >
      <div className="mt-0.5 shrink-0">{icons[toast.variant || "info"]}</div>
      <div className="flex-1 space-y-1 pr-6">
        <h3 className="text-sm font-medium text-slate-100">{toast.title}</h3>
        {toast.description && <p className="text-sm text-slate-400">{toast.description}</p>}
      </div>
      <button
        onClick={handleRemove}
        className="absolute right-2 top-2 rounded-md p-1 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
        <span className="sr-only">Close</span>
      </button>
    </div>
  );
}
