"use client";

import { useState } from "react";
import { AuroraBackdrop, ResearchGrid } from "../../components/ui/aurora-backdrop";
import { ScrollProgress } from "../../components/ui/scroll-progress";
import { Reveal } from "../../components/ui/reveal";
import { Sidebar } from "../../components/layout/sidebar";
import { MobileSidebar } from "../../components/layout/mobile-sidebar";
import { ToastProvider } from "../../components/ui/toast";
import { ErrorBoundary } from "../../components/ui/error-boundary";
import { TopBar } from "../../components/layout/top-bar";
import { CommandPalette } from "../../components/ui/command-palette";
import { KeyboardShortcutsDialog } from "../../components/ui/keyboard-shortcuts-dialog";
import { NotificationBell } from "../../components/layout/notification-bell";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <ToastProvider>
      <div className="relative isolate min-h-screen bg-slate-950 flex flex-col lg:flex-row">
        <ScrollProgress />
        <AuroraBackdrop />
        <ResearchGrid />

        {/* Desktop Sidebar — persistent across all routes */}
        <aside
          className={`relative z-20 hidden lg:flex shrink-0 border-r border-white/10 bg-slate-950/45 backdrop-blur-xl h-screen sticky top-0 flex-col transition-[width] duration-300 ease-out ${collapsed ? "w-[68px]" : "w-72"}`}
        >
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-8">
            <Sidebar collapsed={collapsed} onToggleCollapse={() => setCollapsed((p) => !p)} />
          </div>
        </aside>

        {/* Mobile Top Bar */}
        <TopBar onOpenMobileSidebar={() => setMobileOpen(true)} />

        {/* Mobile Sidebar Drawer */}
        <MobileSidebar open={mobileOpen} onClose={() => setMobileOpen(false)}>
          <Sidebar collapsed={false} onToggleCollapse={() => setMobileOpen(false)} />
        </MobileSidebar>

        {/* Main Content Area */}
        <main className="flex-1 relative z-10 w-full min-w-0 px-4 py-6 sm:px-6 lg:px-12 lg:py-12 overflow-x-hidden">
          <div className="absolute top-4 right-4 sm:top-6 sm:right-6 lg:top-8 lg:right-12 z-50">
            <NotificationBell />
          </div>
          <div className="mx-auto max-w-6xl pt-10 lg:pt-0">
            <ErrorBoundary>
              <Reveal delayMs={90}>
                {children}
              </Reveal>
            </ErrorBoundary>
          </div>
          <CommandPalette />
          <KeyboardShortcutsDialog />
        </main>
      </div>
    </ToastProvider>
  );
}
