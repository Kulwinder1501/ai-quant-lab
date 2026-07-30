import React, { ReactNode } from 'react';
import { classNames } from './class-names';
import { GlassPanel } from './glass-panel';

interface StatCardProps {
  label: ReactNode;
  value: string | number;
  hint?: string;
  trend?: number;
  trendLabel?: string;
  icon?: ReactNode;
  accent?: 'cyan' | 'emerald' | 'rose' | 'amber';
}

export function StatCard({ label, value, hint, trend, trendLabel, icon, accent = 'cyan' }: StatCardProps) {
  const accentColors = {
    cyan: 'text-cyan-400',
    emerald: 'text-emerald-400',
    rose: 'text-rose-400',
    amber: 'text-amber-400'
  };

  return (
    <GlassPanel className="p-5 flex flex-col gap-3 relative overflow-hidden group">
      <div className="flex justify-between items-start z-10">
        <h3 className="text-sm font-medium text-slate-400">{label}</h3>
        {icon && (
          <div className={classNames("p-2 rounded-lg bg-slate-800/50", accentColors[accent])}>
            {icon}
          </div>
        )}
      </div>
      
      <div className="flex items-baseline gap-2 z-10">
        <span className="text-3xl font-bold text-slate-100">{value}</span>
      </div>

      {(trend !== undefined || hint) && (
        <div className="flex items-center gap-2 mt-auto text-sm z-10">
          {trend !== undefined && (
            <span className={classNames(
              "font-medium",
              trend > 0 ? "text-emerald-400" : trend < 0 ? "text-rose-400" : "text-slate-400"
            )}>
              {trend > 0 ? '+' : ''}{trend}%
            </span>
          )}
          {trendLabel && <span className="text-slate-500">{trendLabel}</span>}
          {hint && <span className="text-slate-500">{hint}</span>}
        </div>
      )}
      
      <div className={classNames(
        "absolute -right-4 -top-4 w-24 h-24 rounded-full opacity-10 blur-xl transition-opacity group-hover:opacity-20",
        accent === 'cyan' ? 'bg-cyan-500' : accent === 'emerald' ? 'bg-emerald-500' : accent === 'rose' ? 'bg-rose-500' : 'bg-amber-500'
      )} />
    </GlassPanel>
  );
}
