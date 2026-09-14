import { GlassPanel } from "../../../components/ui/glass-panel";
import { Reveal } from "../../../components/ui/reveal";
import { Tooltip } from "../../../components/ui/tooltip";
import { formatNumber } from "../../research/presentation";
import { algorithmLabel, type ModelFamilySummary } from "../domain";

function metric(value: number | null, fractionDigits = 3): string {
  return value === null ? "—" : formatNumber(value, fractionDigits);
}

export function ModelFamilies({ families }: { families: ModelFamilySummary[] }) {
  if (families.length === 0) return null;

  return (
    <Reveal delayMs={90}>
      <GlassPanel className="border-white/10 p-6">
        <h3 className="text-sm font-extrabold uppercase tracking-wider text-slate-300">
          Model families and their production slot
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          Each family holds one production slot. Two algorithms only compete for the same slot when they were
          trained under one shared model key.
        </p>
        <div className="mt-4 grid gap-3 lg:grid-cols-2 max-h-96 overflow-y-auto pr-2">
          {families.map((family) => (
            <div className="rounded-xl border border-white/10 bg-slate-950/60 p-4" key={family.modelKey}>
              <p className="break-all font-mono text-[11px] text-slate-400">{family.modelKey}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-md border border-white/10 bg-slate-900 px-2 py-0.5 font-bold text-slate-200">
                  {family.versionCount} version{family.versionCount === 1 ? "" : "s"}
                </span>
                {family.algorithms.map((algorithm) => (
                  <span
                    className="rounded-md border border-cyan-300/25 bg-cyan-300/10 px-2 py-0.5 font-bold text-cyan-100"
                    key={algorithm}
                  >
                    {algorithmLabel(algorithm)}
                  </span>
                ))}
                <span className={`rounded-md border px-2 py-0.5 font-bold ${
                  family.productionVersionId
                    ? "border-emerald-300/35 bg-emerald-300/10 text-emerald-100"
                    : "border-slate-500/35 bg-slate-500/10 text-slate-300"
                }`}>
                  {family.productionVersionId ? "Production model promoted" : "No production model"}
                </span>
                <span className="text-slate-400">
                  Best holdout <Tooltip content="Harmonic mean of precision and recall. Accounts for class imbalance.">macro-F1</Tooltip> {metric(family.bestValidationMacroF1)}
                </span>
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>
    </Reveal>
  );
}
