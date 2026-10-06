"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Bot, Wifi, WifiOff } from "lucide-react";
import { useToast } from "../ui/toast";
import { useAppStore } from "../../stores/app-store";
import {
  automatedTradeContractLabel,
  automatedTradeSourceLabel,
  automatedTradeToastDescription,
  type AutomatedTradeOpenedNotification,
} from "./trade-notification";

const MAX_NOTIFICATIONS = 20;

function normalizedApiV1Url(configuredUrl: string): string {
  const base = configuredUrl.trim().replace(/\/+$/, "");
  return base.endsWith("/api/v1") ? base : `${base}/api/v1`;
}

function parseNotification(value: string): AutomatedTradeOpenedNotification | null {
  try {
    const parsed = JSON.parse(value) as AutomatedTradeOpenedNotification;
    return parsed && typeof parsed.eventId === "string" && typeof parsed.paperTradeId === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/** Global, non-blocking frontend consumer for committed automated paper-trade entries. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [connected, setConnected] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<AutomatedTradeOpenedNotification[]>([]);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const seenEventIds = useRef(new Set<string>());
  const { toast } = useToast();
  const apiBaseUrl = useAppStore((state) => state.apiBaseUrl);
  const streamUrl = useMemo(
    () => `${normalizedApiV1Url(apiBaseUrl)}/stream/paper-trade-notifications`,
    [apiBaseUrl],
  );

  const acceptNewNotification = useCallback((notification: AutomatedTradeOpenedNotification) => {
    if (seenEventIds.current.has(notification.eventId)) return;
    seenEventIds.current.add(notification.eventId);
    setNotifications((current) => [notification, ...current].slice(0, MAX_NOTIFICATIONS));
    setUnreadCount((count) => count + 1);
    toast({
      title: `Bot opened ${automatedTradeContractLabel(notification)}`,
      description: automatedTradeToastDescription(notification),
      variant: "success",
      duration: 10_000,
    });
    // Views that are already open can refresh their read model without owning another stream.
    window.dispatchEvent(new CustomEvent("automated-paper-trade-opened", {
      detail: notification,
    }));
  }, [toast]);

  useEffect(() => {
    let eventSource: EventSource | null = new EventSource(streamUrl);

    eventSource.onopen = () => setConnected(true);
    eventSource.onerror = () => {
      // Native EventSource reconnects using the retry value supplied by the API.
      setConnected(false);
    };

    eventSource.addEventListener("snapshot", (event) => {
      try {
        const payload = JSON.parse((event as MessageEvent<string>).data) as {
          data?: AutomatedTradeOpenedNotification[];
        };
        const recent = Array.isArray(payload.data) ? payload.data : [];
        if (!initializedRef.current) {
          initializedRef.current = true;
          seenEventIds.current = new Set(recent.map((notification) => notification.eventId));
          // Existing trades are useful in the bell but are not falsely announced as new.
          setNotifications(recent.slice(0, MAX_NOTIFICATIONS));
          return;
        }
        // A reconnect snapshot recovers anything committed while the connection was down.
        for (const notification of [...recent].reverse()) acceptNewNotification(notification);
      } catch {
        // A malformed SSE message is ignored; it must not break the global dashboard layout.
      }
    });

    eventSource.addEventListener("trade-opened", (event) => {
      const notification = parseNotification((event as MessageEvent<string>).data);
      if (notification) acceptNewNotification(notification);
    });

    return () => {
      eventSource?.close();
      eventSource = null;
      setConnected(false);
    };
  }, [acceptNewNotification, streamUrl]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleOpen = () => {
    setOpen((current) => {
      const next = !current;
      if (next) setUnreadCount(0);
      return next;
    });
  };

  return (
    <div className="relative inline-block" ref={dropdownRef}>
      <button
        type="button"
        onClick={toggleOpen}
        className="relative rounded-full p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-500"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-rose-500 px-1 text-center text-[10px] font-bold leading-5 text-white shadow-lg shadow-rose-950/40">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-[min(22rem,calc(100vw-2rem))] origin-top-right rounded-xl border border-slate-700 bg-slate-900 shadow-xl ring-1 ring-black/5">
          <div className="flex items-center justify-between border-b border-slate-800 p-4">
            <div>
              <h3 className="text-sm font-semibold text-slate-200">Automated trade notifications</h3>
              <p className="mt-0.5 text-xs text-slate-500">Committed paper entries only</p>
            </div>
            <span className={`flex items-center gap-1 text-xs ${connected ? "text-emerald-400" : "text-amber-400"}`}>
              {connected ? <Wifi className="h-3.5 w-3.5" /> : <WifiOff className="h-3.5 w-3.5" />}
              {connected ? "Live" : "Reconnecting"}
            </span>
          </div>
          <div className="max-h-96 overflow-y-auto" aria-live="polite">
            {notifications.length === 0 ? (
              <div className="p-6 text-center text-sm text-slate-500">
                No automated paper trades have opened yet.
              </div>
            ) : notifications.map((notification) => (
              <Link
                key={notification.eventId}
                href="/paper-trading"
                onClick={() => {
                  useAppStore.getState().setActiveAccountId(notification.accountId);
                  setOpen(false);
                }}
                className="flex gap-3 border-b border-slate-800/80 p-4 transition-colors last:border-b-0 hover:bg-slate-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500"
              >
                <div className="mt-0.5 rounded-lg bg-emerald-500/10 p-2 text-emerald-400">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-3">
                    <p className="truncate text-sm font-medium text-slate-200">
                      {automatedTradeContractLabel(notification)}
                    </p>
                    <time className="shrink-0 text-[11px] text-slate-500">
                      {new Date(notification.occurredAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </time>
                  </div>
                  <p className="mt-1 text-xs text-slate-400">
                    {automatedTradeSourceLabel(notification.source)} · Qty {notification.quantity}
                    {notification.timeframe ? ` · ${notification.timeframe}` : ""}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Entry ₹{notification.entryPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
                    {` · ${notification.accountName}`}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
