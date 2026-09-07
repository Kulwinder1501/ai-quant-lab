"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { PieChart as PieChartIcon } from "lucide-react";

export interface WinRateData {
  name: string;
  value: number;
  color: string;
}

interface Props {
  winRate: number; // 0 to 100
  height?: number | string;
}

export function WinRateDonut({ winRate, height = 200 }: Props) {
  if (winRate === undefined || winRate === null) {
    return (
      <div 
        className="flex flex-col items-center justify-center w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl"
        style={{ height }}
      >
        <PieChartIcon className="w-8 h-8 text-white/30 mb-2" />
        <p className="text-white/50 text-xs font-medium">No data</p>
      </div>
    );
  }

  const data: WinRateData[] = [
    { name: "Win", value: winRate, color: "#10b981" },
    { name: "Loss", value: 100 - winRate, color: "#ef4444" },
  ];

  return (
    <div className="w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl p-4 relative" style={{ height }}>
      <div className="absolute inset-0 flex items-center justify-center flex-col z-10 pointer-events-none">
        <span className="text-2xl font-bold text-white">{winRate.toFixed(1)}%</span>
        <span className="text-xs text-white/50 uppercase tracking-wider">Win Rate</span>
      </div>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip 
            contentStyle={{ 
              backgroundColor: 'rgba(0,0,0,0.8)', 
              borderColor: 'rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#fff'
            }}
            itemStyle={{ color: '#fff' }}
          />
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius="70%"
            outerRadius="90%"
            paddingAngle={2}
            dataKey="value"
            stroke="none"
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
    </div>
  );
}
