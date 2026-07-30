import { Reveal } from "../../../components/ui/reveal";

export function SentimentSummary({ 
  summary, 
  cbStatus 
}: { 
  summary: { averageScore: number, articleCount: number, bullishCount: number, bearishCount: number }, 
  cbStatus: { label: string, color: string } 
}) {
  return (
    <Reveal>
      <div className={`rounded-2xl border p-5 shadow-2xl backdrop-blur-xl transition-all ${cbStatus.color}`}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">⚡</span>
            <div>
              <h2 className="text-base font-bold tracking-wide uppercase">System Defense Status</h2>
              <p className="text-sm font-semibold mt-0.5">{cbStatus.label}</p>
            </div>
          </div>
          <div className="flex items-center gap-6 text-right">
            <div>
              <span className="text-xs uppercase tracking-wider opacity-80 block">12H Rolling Sentiment</span>
              <span className={`text-2xl font-black ${summary.averageScore > 0 ? "text-emerald-400" : summary.averageScore < 0 ? "text-rose-400" : "text-slate-300"}`}>
                {summary.averageScore > 0 ? `+${summary.averageScore}` : summary.averageScore}
              </span>
            </div>
            <div className="border-l border-white/10 pl-6 hidden sm:block">
              <span className="text-xs uppercase tracking-wider opacity-80 block">Article Breakdown</span>
              <span className="text-sm font-semibold">
                <span className="text-emerald-400">{summary.bullishCount} Bull</span> / <span className="text-rose-400">{summary.bearishCount} Bear</span> ({summary.articleCount} Total)
              </span>
            </div>
          </div>
        </div>
      </div>
    </Reveal>
  );
}
