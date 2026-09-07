"use client";

import { useState } from "react";
import { Modal } from "./modal";
import { useKeyboardShortcut } from "../../hooks/use-keyboard-shortcut";

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useState(false);

  // Triggered by '?' key.
  useKeyboardShortcut({ key: "?", shiftKey: true }, () => setOpen(true));

  return (
    <Modal
      open={open}
      onClose={() => setOpen(false)}
      title="Keyboard Shortcuts"
      description="Power user shortcuts for faster navigation"
      size="md"
    >
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <span className="text-slate-300">Command Palette</span>
          <div className="flex gap-1">
            <kbd className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 font-mono">⌘ / Ctrl</kbd>
            <kbd className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 font-mono">K</kbd>
          </div>
        </div>
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <span className="text-slate-300">Keyboard Shortcuts</span>
          <kbd className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 font-mono">?</kbd>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-slate-300">Close Dialogs</span>
          <kbd className="px-2 py-1 bg-slate-800 border border-slate-700 rounded text-xs text-slate-300 font-mono">Esc</kbd>
        </div>
      </div>
    </Modal>
  );
}
