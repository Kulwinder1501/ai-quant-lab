"use client";

import { useState, useRef, useEffect } from "react";
import { Bell } from "lucide-react";

const MOCK_NOTIFICATIONS = [
  { id: 1, title: "Backtest Complete", message: "Momentum Strategy backtest finished.", time: "2m ago" },
  { id: 2, title: "Market Alert", message: "BTC crossed $65,000.", time: "1h ago" },
  { id: 3, title: "System Update", message: "New analytics features available.", time: "2h ago" },
];

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
        <span className="absolute top-1.5 right-1.5 block h-2 w-2 rounded-full bg-cyan-500 ring-2 ring-slate-950"></span>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 origin-top-right rounded-xl border border-slate-700 bg-slate-900 shadow-xl ring-1 ring-black ring-opacity-5 focus:outline-none z-50">
          <div className="p-4 border-b border-slate-800 flex justify-between items-center">
            <h3 className="text-sm font-semibold text-slate-200">Notifications</h3>
            <span className="bg-cyan-500/20 text-cyan-400 text-xs px-2 py-0.5 rounded-full font-medium">
              3 new
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {MOCK_NOTIFICATIONS.length > 0 ? (
              <div className="py-2">
                {MOCK_NOTIFICATIONS.map((notif) => (
                  <div key={notif.id} className="px-4 py-3 hover:bg-slate-800/50 transition-colors cursor-pointer border-l-2 border-transparent hover:border-cyan-500">
                    <p className="text-sm font-medium text-slate-200">{notif.title}</p>
                    <p className="text-sm text-slate-400 mt-1">{notif.message}</p>
                    <p className="text-xs text-slate-500 mt-1.5">{notif.time}</p>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-sm text-slate-500">
                No new notifications.
              </div>
            )}
          </div>
          <div className="p-3 border-t border-slate-800 text-center bg-slate-900/50 rounded-b-xl hover:bg-slate-800/50 transition-colors cursor-pointer">
            <button className="text-xs font-medium text-cyan-400 hover:text-cyan-300 w-full">
              View all notifications
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
