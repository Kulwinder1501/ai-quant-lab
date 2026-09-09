"use client";

import { useState } from "react";
import { Command } from "cmdk";
import { useKeyboardShortcut } from "../../hooks/use-keyboard-shortcut";
import { useRouter } from "next/navigation";
import { 
  LayoutDashboard, 
  Moon, 
  Sun, 
  Settings, 
  PieChart, 
  Activity, 
  Folder, 
  FileCode, 
  Shield 
} from "lucide-react";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  const toggleOpen = () => setOpen((o) => !o);
  const close = () => setOpen(false);

  // Triggered by useKeyboardShortcut (ctrl+k / meta+k)
  useKeyboardShortcut({ key: "k", metaKey: true }, toggleOpen);
  useKeyboardShortcut({ key: "k", ctrlKey: true }, toggleOpen);
  useKeyboardShortcut({ key: "Escape" }, close);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[20vh] bg-slate-950/60 backdrop-blur-sm">
      <div 
        className="fixed inset-0" 
        onClick={close}
      />
      <Command 
        className="relative z-50 w-full max-w-lg rounded-xl border border-white/10 bg-slate-900/90 shadow-2xl backdrop-blur-xl overflow-hidden"
      >
        <div className="flex items-center border-b border-white/10 px-3">
          <Command.Input 
            autoFocus
            placeholder="Type a command or search..." 
            className="w-full bg-transparent p-4 text-sm text-slate-200 placeholder-slate-400 focus:outline-none"
          />
        </div>
        
        <Command.List className="max-h-[300px] overflow-y-auto p-2 text-slate-300">
          <Command.Empty className="py-6 text-center text-sm text-slate-400">
            No results found.
          </Command.Empty>

          <Command.Group heading="Navigation" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-slate-500">
            <Command.Item 
              onSelect={() => { router.push('/'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <LayoutDashboard className="h-4 w-4" /> Dashboard
            </Command.Item>
            <Command.Item 
              onSelect={() => { router.push('/portfolio'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <PieChart className="h-4 w-4" /> Portfolio
            </Command.Item>
            <Command.Item 
              onSelect={() => { router.push('/dashboard'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <Activity className="h-4 w-4" /> Market Data
            </Command.Item>
            <Command.Item 
              onSelect={() => { router.push('/strategy'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <FileCode className="h-4 w-4" /> Strategies
            </Command.Item>

            <Command.Item 
              onSelect={() => { router.push('/ai-models'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <Folder className="h-4 w-4" /> Analytics
            </Command.Item>

            <Command.Item 
              onSelect={() => { router.push('/settings'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <Settings className="h-4 w-4" /> Settings
            </Command.Item>

            <Command.Item 
              onSelect={() => { router.push('/settings'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <Shield className="h-4 w-4" /> Security
            </Command.Item>
          </Command.Group>

          <Command.Group heading="Actions" className="mt-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-slate-500">
            <Command.Item 
              onSelect={() => { document.documentElement.classList.add('dark'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <Moon className="h-4 w-4" /> Dark Theme
            </Command.Item>
            <Command.Item 
              onSelect={() => { document.documentElement.classList.remove('dark'); close(); }}
              className="flex items-center cursor-pointer gap-2 rounded-md px-2 py-2.5 text-sm aria-selected:bg-cyan-500/20 aria-selected:text-cyan-300"
            >
              <Sun className="h-4 w-4" /> Light Theme
            </Command.Item>
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}
