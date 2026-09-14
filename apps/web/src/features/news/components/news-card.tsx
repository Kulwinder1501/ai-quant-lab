import { type NewsArticle } from "./news-dashboard";

export function NewsCard({ art }: { art: NewsArticle }) {
  const isBull = art.sentimentLabel === "BULLISH";
  const isBear = art.sentimentLabel === "BEARISH";
  const isVol = art.sentimentLabel === "HIGH_VOLATILITY";

  const badgeStyle = isBull
    ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
    : isBear
      ? "bg-rose-500/15 text-rose-300 border-rose-500/30"
      : isVol
        ? "bg-purple-500/15 text-purple-300 border-purple-500/30"
        : "bg-slate-800/60 text-slate-300 border-slate-700";

  const badgeText = isBull
    ? `🟢 BULLISH (${art.sentimentScore > 0 ? "+" : ""}${art.sentimentScore})`
    : isBear
      ? `🔴 BEARISH (${art.sentimentScore})`
      : isVol
        ? `⚡ VOLATILE (${art.sentimentScore})`
        : `⚪ NEUTRAL (${art.sentimentScore})`;

  const providerName = 
    art.provider === "MONEYCONTROL" ? "Moneycontrol" : 
    art.provider === "ECONOMIC_TIMES" ? "Economic Times" : 
    art.provider === "TIMES_OF_INDIA" ? "Times of India" :
    art.provider === "BUSINESS_STANDARD" ? "Business Standard" :
    art.provider === "NDTV_PROFIT" ? "NDTV Profit" :
    art.provider === "LIVEMINT" ? "LiveMint" : art.provider;
  const pubDate = new Date(art.publishedAt);
  const timeStr = !isNaN(pubDate.getTime())
    ? pubDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + " · " + pubDate.toLocaleDateString([], { month: "short", day: "numeric" })
    : "Recent";

  return (
    <div
      className="group relative flex flex-col justify-between rounded-2xl border border-white/10 bg-slate-950/50 p-5 backdrop-blur-md hover:border-cyan-500/40 hover:bg-slate-900/60 transition-all duration-300 shadow-xl"
    >
      <div>
        {/* Top Header Row */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <span className="inline-flex items-center rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] font-semibold text-slate-300 border border-white/10">
            {providerName}
          </span>
          <span className="text-[11px] font-medium text-slate-400">{timeStr}</span>
        </div>

        {/* Title */}
        <h3 className="text-base font-bold text-slate-100 group-hover:text-cyan-300 transition-colors line-clamp-2 leading-snug">
          {art.title}
        </h3>

        {/* Description */}
        <p className="mt-3 text-xs md:text-sm text-slate-300/90 line-clamp-5 leading-relaxed font-normal">
          {art.description}
        </p>
      </div>

      {/* Footer Badges */}
      <div className="mt-5 pt-4 border-t border-white/5 flex flex-wrap items-center justify-between gap-2">
        <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold ${badgeStyle}`}>
          {badgeText}
        </span>

        <div className="flex items-center gap-1">
          {art.symbolsMentioned?.map((s) => (
            <span
              key={s}
              className="rounded bg-cyan-950/50 px-1.5 py-0.5 text-[10px] font-bold text-cyan-400 border border-cyan-800/40"
            >
              {s}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
