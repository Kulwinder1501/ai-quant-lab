import { GlassPanel } from "../../../components/ui/glass-panel";

interface ReadOnlyBoundaryProps {
  title: string;
  description: string;
  points: string[];
  badge?: string;
}

export function ReadOnlyBoundary({
  title,
  description,
  points,
  badge = "READ ONLY",
}: ReadOnlyBoundaryProps) {
  return (
    <GlassPanel className="border-cyan-300/25 bg-cyan-300/[0.045] p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-cyan-100">Safety boundary</p>
          <h2 className="mt-2 text-lg font-semibold text-slate-100">{title}</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">{description}</p>
        </div>
        <span className="rounded-full border border-cyan-200/35 bg-cyan-200/10 px-3 py-1 text-xs font-semibold text-cyan-50">{badge}</span>
      </div>
      <ul className="mt-4 grid gap-2 text-xs text-slate-300 grid-cols-1 md:grid-cols-2 lg:grid-cols-4">
        {points.map((point) => <li className="rounded-lg bg-slate-950/35 px-3 py-2" key={point}>{point}</li>)}
      </ul>
    </GlassPanel>
  );
}
