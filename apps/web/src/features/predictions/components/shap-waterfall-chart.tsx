"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { BarChartHorizontal } from "lucide-react";

export interface ShapData {
  feature: string;
  value: number;
}

interface Props {
  data: ShapData[];
  height?: number | string;
}

export function ShapWaterfallChart({ data, height = 350 }: Props) {
  if (!data || data.length === 0) {
    return (
      <div 
        className="flex flex-col items-center justify-center w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl"
        style={{ height }}
      >
        <BarChartHorizontal className="w-12 h-12 text-white/30 mb-4" />
        <p className="text-white/50 text-sm font-medium">No SHAP data</p>
      </div>
    );
  }

  return (
    <div className="w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl p-4" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart 
          data={data} 
          layout="vertical" 
          margin={{ top: 5, right: 30, left: 60, bottom: 5 }}
        >
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" horizontal={false} />
          <XAxis 
            type="number" 
            stroke="rgba(255,255,255,0.5)" 
            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis 
            type="category" 
            dataKey="feature" 
            stroke="rgba(255,255,255,0.5)" 
            tick={{ fill: 'rgba(255,255,255,0.7)', fontSize: 12 }}
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
          <Bar dataKey="value" radius={[0, 4, 4, 0]}>
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.value >= 0 ? '#3b82f6' : '#ef4444'} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
