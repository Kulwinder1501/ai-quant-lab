"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  Zap,
  Newspaper,
  Pin,
  ScrollText,
  Receipt,
  ScanSearch,
  CandlestickChart,
  Lightbulb,
  Wallet,
  FlaskConical,
  BrainCircuit,
  Cpu,
  Timer,
  ClipboardList,
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
        { name: "Positions", href: "/positions", icon: <Pin className="size-5" /> },
        { name: "Orders", href: "/orders", icon: <ScrollText className="size-5" /> },
        { name: "Trade History", href: "/trade-history", icon: <Receipt className="size-5" /> },
        { name: "Paper Trading", href: "/paper-trading", icon: <Wallet className="size-5" /> },
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
      title: "SCALPING",
      items: [
        { name: "Scalp Strategy", href: "/scalp-strategy", icon: <Timer className="size-5" /> },
        { name: "Scalp History", href: "/scalp-trade-history", icon: <ClipboardList className="size-5" /> },
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
      "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-200 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-950 motion-reduce:transition-none",
      pathname === href
        ? "bg-cyan-300/15 text-cyan-100 shadow-inner shadow-cyan-200/10"
        : "text-slate-300 hover:bg-white/5 hover:text-slate-100",
      collapsed ? "justify-center px-0" : ""
    );

  return (
    <div className="flex h-full flex-col">
      <div className={classNames("flex items-center gap-3 px-4 py-6 sm:px-6 lg:px-6 lg:py-8", collapsed ? "justify-center px-0" : "")}>
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-blue-600 shadow-lg shadow-cyan-500/20">
          <svg className="h-6 w-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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

      <div className="flex-1 overflow-y-auto px-4 pb-4 scrollbar-hide">
        <nav aria-label="Sidebar navigation" className="flex flex-col gap-6">
          {sections.map((section, idx) => (
            <div key={idx}>
              {!collapsed && (
                <div className="mb-2 pl-3 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  {section.title}
                </div>
              )}
              <div className="flex flex-col gap-1.5">
                {section.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={pathname === item.href ? "page" : undefined}
                    className={linkClass(item.href)}
                    title={collapsed ? item.name : undefined}
                  >
                    {item.icon}
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
            className={linkClass("/settings")}
            title={collapsed ? "Settings" : undefined}
          >
            <Settings className="size-5" />
            {!collapsed && <span>Settings</span>}
          </Link>
        </nav>
      </div>

      <div className="p-4 border-t border-white/10">
        <button
          onClick={onToggleCollapse}
          className="flex w-full items-center justify-center rounded-lg p-2 text-slate-400 hover:bg-white/5 hover:text-slate-100 transition"
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          {collapsed ? <ChevronRight className="size-5" /> : <ChevronLeft className="size-5" />}
        </button>
      </div>
    </div>
  );
}
