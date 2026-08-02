"use client";

import Link from "next/link";
import { classNames } from "../../../components/ui/class-names";

export type ResearchView =
  | "dashboard"
  | "news"
  | "scanner"
  | "charts"
  | "strategy"
  | "paper-trading"
  | "positions-orders"
  | "trade-history"
  | "backtesting"
  | "predictions"
  | "model-performance"
  | "scalp-strategy";

export function ResearchNavigation({ activeView }: { activeView: ResearchView }) {
  const linkClass = (view: ResearchView) => classNames(
    "block w-full rounded-lg px-3 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 motion-reduce:transition-none",
    activeView === view
      ? "bg-cyan-300/15 text-cyan-100 shadow-inner shadow-cyan-200/10"
      : "text-slate-300 hover:bg-white/5 hover:text-slate-100",
  );

  return (
    <nav aria-label="Research dashboard views" className="flex flex-col gap-1.5 w-full">
      <Link aria-current={activeView === "dashboard" ? "page" : undefined} className={linkClass("dashboard")} href="/dashboard">
        ⚡ Live Dashboard
      </Link>
      <Link aria-current={activeView === "news" ? "page" : undefined} className={linkClass("news")} href="/news">
        📰 Market News
      </Link>
      <Link aria-current={activeView === "positions-orders" ? "page" : undefined} className={linkClass("positions-orders")} href="/positions-orders">
        Positions &amp; Orders
      </Link>
      <Link aria-current={activeView === "trade-history" ? "page" : undefined} className={linkClass("trade-history")} href="/trade-history">
        🧾 Trade History
      </Link>
      <Link aria-current={activeView === "scanner" ? "page" : undefined} className={linkClass("scanner")} href="/">
        Market Scanner
      </Link>
      <Link aria-current={activeView === "charts" ? "page" : undefined} className={linkClass("charts")} href="/charts">
        Interactive Charts
      </Link>
      <Link aria-current={activeView === "strategy" ? "page" : undefined} className={linkClass("strategy")} href="/strategy">
        Strategy & Ideas
      </Link>
      
      {/* Scalp Features */}
      <div className="mt-2 mb-1 pl-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">Scalping</div>
      <Link aria-current={activeView === "scalp-strategy" ? "page" : undefined} className={linkClass("scalp-strategy")} href="/scalp-strategy">
        ⚡ Scalp Strategy & Ideas
      </Link>
      <div className="my-1 border-t border-slate-700/50 w-full" />

      <Link aria-current={activeView === "paper-trading" ? "page" : undefined} className={linkClass("paper-trading")} href="/paper-trading">
        Paper Trading
      </Link>
      <Link aria-current={activeView === "backtesting" ? "page" : undefined} className={linkClass("backtesting")} href="/backtesting">
        Backtesting Reports
      </Link>
      <Link aria-current={activeView === "predictions" ? "page" : undefined} className={linkClass("predictions")} href="/predictions">
        AI Predictions
      </Link>
      <Link aria-current={activeView === "model-performance" ? "page" : undefined} className={linkClass("model-performance")} href="/model-performance">
        🧠 Model Performance
      </Link>
    </nav>
  );
}
