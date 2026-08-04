"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Zap,
  Newspaper,
  ScrollText,
  Receipt,
  ScanSearch,
  CandlestickChart,
  Lightbulb,
  FlaskConical,
  BrainCircuit,
  Cpu,
  Settings,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { classNames } from "../ui/class-names";
import { type ReactNode } from "react";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

interface NavItem {
  name: string;
  href: string;
  icon: ReactNode;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

export function Sidebar({ collapsed, onToggleCollapse }: SidebarProps) {
  const pathname = usePathname();

  const sections: NavSection[] = [
    {
      title: "MARKETS",
      items: [
        { name: "Live Dashboard", href: "/dashboard", icon: <Zap className="size-5" /> },
        { name: "Market News", href: "/news", icon: <Newspaper className="size-5" /> },
        { name: "Market Scanner", href: "/", icon: <ScanSearch className="size-5" /> },
        { name: "Interactive Charts", href: "/charts", icon: <CandlestickChart className="size-5" /> },
      ],
    },
    {
      title: "TRADING",
      items: [
        { name: "Positions & Orders", href: "/positions-orders", icon: <ScrollText className="size-5" /> },
        { name: "Trade History", href: "/trade-history", icon: <Receipt className="size-5" /> },
      ],
    },
    {
      title: "STRATEGY",
      items: [
        { name: "Strategy & Ideas", href: "/strategy", icon: <Lightbulb className="size-5" /> },
        { name: "Backtesting", href: "/backtesting", icon: <FlaskConical className="size-5" /> },
      ],
    },
    {
      title: "AI & ML",
      items: [
        { name: "AI Predictions", href: "/predictions", icon: <BrainCircuit className="size-5" /> },
        { name: "Model Performance", href: "/model-performance", icon: <Cpu className="size-5" /> },
      ],
    },
  ];

  const linkClass = (href: string) =>
    classNames(
      "flex items-center rounded-lg text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 motion-reduce:transition-none",
      pathname === href
        ? "bg-cyan-300/15 text-cyan-100 shadow-inner shadow-cyan-200/10"
        : "text-slate-300 hover:bg-white/5 hover:text-slate-100",
      // Collapsed rail: square centered icon hits. Expanded: label + icon row.
      collapsed ? "justify-center size-10 mx-auto" : "gap-3 px-3 py-2",
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={classNames(
          "flex shrink-0 items-center gap-3 py-4",
          collapsed ? "justify-center px-2" : "px-4 sm:px-6",
        )}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 shadow-lg shadow-cyan-500/20">
          <svg className="h-6 w-6 text-static-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
          </svg>
        </div>
        {!collapsed && (
          <div className="overflow-hidden">
            <h2 className="text-lg font-bold text-white tracking-tight whitespace-nowrap">AI Quant Lab</h2>
            <p className="text-xs text-cyan-400 font-medium tracking-wide whitespace-nowrap">TRADING TERMINAL</p>
          </div>
        )}
      </div>

      <div
        className={classNames(
          "min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3 scrollbar-hide",
          collapsed ? "px-2" : "px-4",
        )}
      >
        <nav aria-label="Sidebar navigation" className="flex flex-col gap-4">
          {sections.map((section, idx) => (
            <div key={idx} className={collapsed ? "flex flex-col items-center gap-1.5" : undefined}>
              {!collapsed && (
                <div className="mb-1.5 pl-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  {section.title}
                </div>
              )}
              <div className={classNames("flex flex-col", collapsed ? "items-center gap-1" : "gap-1")}>
                {section.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={pathname === item.href ? "page" : undefined}
                    aria-label={collapsed ? item.name : undefined}
                    className={linkClass(item.href)}
                    title={collapsed ? item.name : undefined}
                  >
                    <span className="shrink-0">{item.icon}</span>
                    {!collapsed && <span>{item.name}</span>}
                  </Link>
                ))}
              </div>
            </div>
          ))}

          <div className="border-t border-slate-700/50 w-full" />

          <Link
            href="/settings"
            aria-current={pathname === "/settings" ? "page" : undefined}
            aria-label={collapsed ? "Settings" : undefined}
            className={linkClass("/settings")}
            title={collapsed ? "Settings" : undefined}
          >
            <Settings className="size-5 shrink-0" />
            {!collapsed && <span>Settings</span>}
          </Link>
        </nav>
      </div>

      <div className={classNames("shrink-0 border-t border-white/10", collapsed ? "p-2" : "p-3")}>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex w-full items-center justify-center rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100 transition"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight className="size-5" /> : <ChevronLeft className="size-5" />}
        </button>
      </div>
    </div>
  );
}
