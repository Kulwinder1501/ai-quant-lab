import { GlassPanel } from "../../../components/ui/glass-panel";
import type { AiBrainThought } from "./live-price-dashboard";
import { useEffect, useState } from "react";
import { getResearchJson } from "../../research/api";

interface MiniBrainNewsProps {
  thoughts: AiBrainThought[];
}

export function MiniBrainNews({ thoughts }: MiniBrainNewsProps) {
  const [news, setNews] = useState<any[]>([]);

  useEffect(() => {
    // Fetch latest news on mount
    getResearchJson("/market-news?limit=10")
      .then((res: any) => {
        if (res?.data?.articles) {
          setNews(res.data.articles.slice(0, 5));
        }
      })
      .catch(() => {}); // ignore
  }, []);

  return (
    <GlassPanel className="border-white/5 bg-slate-900/40 rounded-md h-full flex flex-col p-0 overflow-hidden">
      <div className="flex-1 flex flex-col min-h-0">
        {/* Condensed AI Brain Stream Section */}
        <div className="p-3 flex-1 flex flex-col border-b border-white/[0.02] min-h-0">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5 mb-2 shrink-0">
            <span className="h-3 w-3 flex items-center justify-center text-[10px]">🧠</span>
            AI Brain Feed
          </h3>
          <div className="space-y-1.5 overflow-y-auto custom-scrollbar pr-1 flex-1">
            {thoughts.length === 0 ? (
              <div className="text-[9px] text-slate-500 italic">Initializing AI brain scans...</div>
            ) : (
              thoughts.map((th) => {
                let badgeColor = "text-slate-400";
                if (th.action === "EXECUTING") badgeColor = "text-emerald-400";
                else if (th.action === "PROPOSING") badgeColor = "text-amber-400";
                
                return (
                  <div key={th.id} className="bg-black/30 rounded p-1.5 border border-white/[0.02] hover:bg-black/50 transition">
                    <div className="flex justify-between items-center text-[9px] mb-0.5">
                      <span className={`font-bold ${badgeColor}`}>{th.action}</span>
                      <span className="text-slate-500 font-mono">{new Date(th.timestamp).toLocaleTimeString("en-IN")}</span>
                    </div>
                    <p className="text-[10px] text-slate-300 leading-snug line-clamp-2" title={th.message}>
                      {th.message}
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Condensed News Feed */}
        <div className="p-3 flex-1 flex flex-col min-h-0">
          <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5 mb-2 shrink-0">
            <span className="h-3 w-3 flex items-center justify-center text-[10px]">📰</span>
            Live News
          </h3>
          <div className="space-y-2 overflow-y-auto custom-scrollbar pr-1 flex-1">
            {news.length === 0 ? (
              <div className="text-[9px] text-slate-500 italic">Loading news...</div>
            ) : (
              news.map((art) => (
                <div key={art.id} className="group">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-[8px] font-mono font-bold text-slate-500 px-1 rounded bg-white/5 uppercase">
                      {art.provider}
                    </span>
                    <span className="text-[9px] text-slate-500">
                      {new Date(art.publishedAt).toLocaleTimeString("en-IN", {hour: '2-digit', minute:'2-digit'})}
                    </span>
                  </div>
                  <a href={art.url} target="_blank" rel="noreferrer" className="text-[10px] font-medium text-slate-300 group-hover:text-cyan-400 transition line-clamp-2 leading-snug">
                    {art.title}
                  </a>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </GlassPanel>
  );
}
