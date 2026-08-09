import { useEffect, useState } from "react";
import { GlassPanel } from "../../../components/ui/glass-panel";
import { getApiV1Url } from "../../research/api";

interface OptionChainMetricsProps {
  symbol: string;
}

interface OptionChainData {
  atmImpliedVolatility: number | null;
  atmImpliedVolatilityPercentile: { percentile: number | null; count: number } | null;
  putCall: { volumeRatio: number | null; openInterestRatio: number | null };
  impliedVolatilitySkew: { skew: number | null; putIv: number | null; callIv: number | null } | null;
}

export function OptionChainMetrics({ symbol }: OptionChainMetricsProps) {
  const [data, setData] = useState<OptionChainData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    const fetchMetrics = async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/option-chain?underlying=${symbol}`);
        if (response.ok) {
          const json = await response.json();
          // `available: false` ("no snapshot collected yet") is the route's documented
          // normal early state, not an error -- but that shape carries no putCall,
          // atmImpliedVolatility, or impliedVolatilitySkew fields, so setting it as data
          // would crash the render below. Leaving data null renders nothing, the same
          // as a fetch failure.
          if (mounted && json.data?.available) setData(json.data);
        }
      } catch (err) {
        console.error("Failed to fetch option chain metrics", err);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    void fetchMetrics();
    const interval = setInterval(fetchMetrics, 15000); // refresh every 15s
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, [symbol]);

  if (loading && !data) {
    return (
      <GlassPanel className="p-3 border-white/10 bg-slate-900/40 h-full flex items-center justify-center">
        <span className="text-xs text-slate-500 uppercase tracking-widest animate-pulse">Loading Options Data...</span>
      </GlassPanel>
    );
  }

  if (!data) return null;

  return (
    <GlassPanel className="p-3 border-white/10 bg-slate-900/40 flex flex-col font-sans">
      <div className="flex items-center justify-between mb-3 pb-2 border-b border-white/10">
        <h3 className="text-xs font-black tracking-widest text-slate-300 uppercase flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-indigo-400" />
          Options Context
        </h3>
      </div>
      <div className="flex-1 grid grid-cols-2 gap-3">
        <div className="bg-slate-950/50 rounded flex flex-col justify-center p-2 border border-white/5">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">ATM IV</span>
          <span className="text-lg font-mono font-bold text-indigo-400">
            {data.atmImpliedVolatility ? (data.atmImpliedVolatility * 100).toFixed(2) + "%" : "N/A"}
          </span>
        </div>
        <div className="bg-slate-950/50 rounded flex flex-col justify-center p-2 border border-white/5">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">IV Rank (1y)</span>
          <span className="text-lg font-mono font-bold text-sky-400">
            {data.atmImpliedVolatilityPercentile?.percentile != null
              ? data.atmImpliedVolatilityPercentile.percentile.toFixed(0) + " PR"
              : "N/A"}
          </span>
        </div>
        <div className="bg-slate-950/50 rounded flex flex-col justify-center p-2 border border-white/5">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">PCR (OI)</span>
          <span className={`text-lg font-mono font-bold ${
            (data.putCall.openInterestRatio ?? 1) > 1 ? "text-emerald-400" : "text-rose-400"
          }`}>
            {data.putCall.openInterestRatio ? data.putCall.openInterestRatio.toFixed(2) : "N/A"}
          </span>
        </div>
        <div className="bg-slate-950/50 rounded flex flex-col justify-center p-2 border border-white/5">
          <span className="text-[10px] text-slate-400 font-bold uppercase tracking-wider mb-1">IV Skew (2% OTM)</span>
          <span className={`text-lg font-mono font-bold ${
            (data.impliedVolatilitySkew?.skew ?? 0) > 0 ? "text-emerald-400" : "text-rose-400"
          }`}>
            {data.impliedVolatilitySkew?.skew != null 
              ? (data.impliedVolatilitySkew.skew * 100).toFixed(2) + "%" 
              : "N/A"}
          </span>
        </div>
      </div>
    </GlassPanel>
  );
}
