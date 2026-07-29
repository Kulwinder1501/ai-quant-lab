import type { JsonObject } from "./json";

export function formatTimestamp(value: string | null): string {
  if (!value) return "Not recorded";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? value
    : new Intl.DateTimeFormat("en-IN", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Kolkata",
    }).format(timestamp);
}

export function formatNumber(value: number | null, maximumFractionDigits = 3): string {
  return value === null
    ? "Not recorded"
    : new Intl.NumberFormat("en-IN", { maximumFractionDigits }).format(value);
}

export function formatPercentage(value: number | null): string {
  return value === null ? "Not recorded" : `${(value * 100).toFixed(1)}%`;
}

export function labelTone(label: string | null): string {
  if (label === "BULLISH") return "border-emerald-300/35 bg-emerald-300/10 text-emerald-100";
  if (label === "BEARISH") return "border-rose-300/35 bg-rose-300/10 text-rose-100";
  return "border-amber-200/35 bg-amber-200/10 text-amber-100";
}

export function scalarSummary(values: JsonObject, maximumEntries = 3): string | null {
  const visible = Object.entries(values)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, maximumEntries)
    .map(([key, value]) => `${key}: ${typeof value === "number" ? formatNumber(value) : String(value)}`);
  return visible.length > 0 ? visible.join(" - ") : null;
}
