"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { BarChart2 } from "lucide-react";

export interface TradeDistributionData {
  range: string;
  count: number;
}

interface Props {
  data: TradeDistributionData[];
  height?: number | string;
}

export function TradeDistributionChart({ data, height = 300 }: Props) {
  if (!data || data.length === 0) {
    return (
      <div 
        className="flex flex-col items-center justify-center w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl"
        style={{ height }}
      >
        <BarChart2 className="w-12 h-12 text-white/30 mb-4" />
        <p className="text-white/50 text-sm font-medium">No distribution data</p>
      </div>
    );
  }

  return (
    <div className="w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl p-4" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 20 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
          <XAxis 
            dataKey="range" 
            stroke="rgba(255,255,255,0.5)" 
            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            angle={-45}
            textAnchor="end"
          />
          <YAxis 
            stroke="rgba(255,255,255,0.5)" 
            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip 
            cursor={{ fill: 'rgba(255,255,255,0.05)' }}
            contentStyle={{ 
              backgroundColor: 'rgba(0,0,0,0.8)', 
              borderColor: 'rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#fff'
            }}
          />
          <Bar dataKey="count" radius={[4, 4, 0, 0]}>
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.range.includes('-') && entry.range.startsWith('-') ? '#ef4444' : '#10b981'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
