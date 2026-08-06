"use client";

import { useState } from "react";
import { NewsDashboard } from "../../../features/news/components/news-dashboard";
import { UpcomingEvents } from "../../../features/dashboard/components/upcoming-events";
import { classNames } from "../../../components/ui/class-names";

export default function NewsPage() {
  const [activeTab, setActiveTab] = useState<"news" | "events">("news");

  return (
    <div className="flex h-full flex-col p-4 lg:p-8">
      {/* Tabs Header */}
      <div className="mb-6 flex shrink-0 border-b border-white/10">
        <button
          onClick={() => setActiveTab("news")}
          className={classNames(
            "px-6 py-3 text-sm font-bold uppercase tracking-wider transition-colors",
            activeTab === "news"
              ? "border-b-2 border-cyan-400 text-cyan-300"
              : "text-slate-400 hover:text-slate-200"
          )}
        >
          Market News
        </button>
        <button
          onClick={() => setActiveTab("events")}
          className={classNames(
            "px-6 py-3 text-sm font-bold uppercase tracking-wider transition-colors",
            activeTab === "events"
              ? "border-b-2 border-cyan-400 text-cyan-300"
              : "text-slate-400 hover:text-slate-200"
          )}
        >
          Upcoming Events
        </button>
      </div>

      {/* Tab Content */}
      <div className="min-h-0 flex-1">
        {activeTab === "news" && <NewsDashboard />}
        {activeTab === "events" && (
          <div className="h-full w-full max-w-4xl">
            <UpcomingEvents />
          </div>
        )}
      </div>
    </div>
  );
}
