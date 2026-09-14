"use client";

import { GlassPanel } from "../../components/ui/glass-panel";
import { Reveal } from "../../components/ui/reveal";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Reveal>
      <div className="flex min-h-[50vh] items-center justify-center px-4">
        <GlassPanel className="max-w-lg border-rose-300/30 bg-rose-300/[0.04] p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-400/15">
            <AlertTriangle className="h-7 w-7 text-rose-300" />
          </div>
          <h2 className="mt-5 text-xl font-bold text-white">Something went wrong</h2>
          <p className="mt-3 text-sm leading-relaxed text-slate-300">
            An unexpected error occurred while rendering this page. This does not affect any persisted data or paper trading state.
          </p>
          {error.message && (
            <p className="mt-4 rounded-xl border border-white/5 bg-slate-950/50 px-4 py-3 font-mono text-xs text-slate-400">
              {error.message}
            </p>
          )}
          <button
            className="mt-6 inline-flex items-center gap-2 rounded-xl border border-cyan-300/30 bg-cyan-300/10 px-5 py-2.5 text-sm font-semibold text-cyan-100 shadow-lg transition hover:bg-cyan-300/20 focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950"
            onClick={reset}
            type="button"
          >
            <RotateCcw className="h-4 w-4" />
            Try Again
          </button>
        </GlassPanel>
      </div>
    </Reveal>
  );
}
