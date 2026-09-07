"use client";

import { useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { getResearchJson } from "../../research/api";
import { NewsCard } from "../../news/components/news-card";
import type { NewsArticle } from "../../news/components/news-dashboard";

interface NewsResponse {
  data?: { articles?: NewsArticle[] };
}

export function LiveNewsFeed() {
  const [news, setNews] = useState<NewsArticle[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Fetch latest news on mount
    getResearchJson("/market-news?limit=10")
      .then((value) => {
        const res = value as NewsResponse;
        if (res?.data?.articles) {
          setNews(res.data.articles.slice(0, 4));
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <GlassPanel className="p-6 md:p-8 border-cyan-500/10 bg-slate-900/40 h-full flex flex-col min-h-0">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center border-b border-white/10 pb-4 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-cyan-500/10 border border-cyan-400/20 text-2xl shadow-inner">
            📰
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xl font-black text-white">Live Market News</h3>
              <span className="rounded-full bg-cyan-400/10 px-2.5 py-0.5 text-[10px] font-extrabold font-mono text-cyan-300 border border-cyan-400/30">
                RSS SYNC
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Aggregated real-time financial news and macro sentiment analysis.
            </p>
          </div>
        </div>
      </div>

      <div className="mt-6 min-h-0 flex-1 overflow-y-auto custom-scrollbar pr-2">
        {loading ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <span className="text-2xl animate-spin">⚙️</span>
            <p className="mt-2 font-sans font-bold">Syncing RSS feeds...</p>
          </div>
        ) : news.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-400">
            <p className="font-sans font-bold">No recent news found.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {news.map((art) => (
              <NewsCard key={art.id} art={art} />
            ))}
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
