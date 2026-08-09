"use client";

import { useState, useRef, useEffect } from "react";
import { Bell } from "lucide-react";

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      <button 
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 text-slate-400 hover:text-slate-200 transition-colors focus:outline-none focus:ring-2 focus:ring-cyan-500 rounded-full hover:bg-slate-800"
        aria-label="Notifications"
      >
        <Bell className="h-5 w-5" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 origin-top-right rounded-xl border border-slate-700 bg-slate-900 shadow-xl ring-1 ring-black ring-opacity-5 focus:outline-none z-50">
          <div className="p-4 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-slate-200">Notifications</h3>
          </div>
          <div className="max-h-96 overflow-y-auto">
            <div className="p-4 text-center text-sm text-slate-500">
              No new notifications.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
