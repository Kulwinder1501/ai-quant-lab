import { GlassPanel } from "../../../components/ui/glass-panel";

interface MacroEvent {
  id: string;
  title: string;
  estimate: string;
  previous: string;
  impact: "HIGH" | "MED" | "LOW";
  timeAway: string;
}

const MOCK_EVENTS: MacroEvent[] = [
  { id: "1", title: "CPI Data (US)", estimate: "3.1%", previous: "3.2%", impact: "HIGH", timeAway: "T-02:14:00" },
  { id: "2", title: "FOMC Meeting", estimate: "Rate Decision", previous: "5.50%", impact: "HIGH", timeAway: "T-24:00:00" },
  { id: "3", title: "Initial Jobless", estimate: "215K", previous: "211K", impact: "MED", timeAway: "T-48:00:00" },
  { id: "4", title: "RBI MPC (IN)", estimate: "6.5%", previous: "6.5%", impact: "HIGH", timeAway: "T-72:00:00" },
];

export function UpcomingEvents() {
  return (
    <GlassPanel className="p-3 border-white/5 bg-slate-900/40 flex flex-col h-full rounded-md">
      <div className="flex items-center justify-between border-b border-white/5 pb-2 mb-2">
        <h3 className="text-[10px] font-bold uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
          <span className="h-3 w-3 flex items-center justify-center text-xs">📅</span>
          Upcoming Events
        </h3>
      </div>
      
      <div className="flex-1 overflow-y-auto custom-scrollbar pr-1 space-y-3">
        {MOCK_EVENTS.map((evt) => (
          <div key={evt.id} className="border-b border-white/[0.02] pb-2 last:border-0 last:pb-0">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-bold text-slate-200">{evt.title}</h4>
              <span className={`text-[8px] font-black tracking-wider rounded px-1.5 py-0.5 border ${
                evt.impact === "HIGH" ? "bg-rose-500/10 text-rose-400 border-rose-500/20" :
                evt.impact === "MED" ? "bg-amber-500/10 text-amber-400 border-amber-500/20" :
                "bg-slate-500/10 text-slate-400 border-slate-500/20"
              }`}>
                {evt.impact}
              </span>
            </div>
            <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400 font-mono">
              <div>
                <span className="text-slate-500">Est:</span> {evt.estimate} <span className="text-slate-600 px-1">|</span> <span className="text-slate-500">Prev:</span> {evt.previous}
              </div>
              <div className="text-cyan-400 font-bold">{evt.timeAway}</div>
            </div>
          </div>
        ))}
      </div>
    </GlassPanel>
  );
}
