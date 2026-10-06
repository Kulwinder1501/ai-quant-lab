"use client";

import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { Activity } from "lucide-react";

export interface EquityData {
  date: string;
  equity: number;
}

interface Props {
  data: EquityData[];
  height?: number | string;
}

export function EquityCurveChart({ data, height = 350 }: Props) {
  if (!data || data.length === 0) {
    return (
      <div 
        className="flex flex-col items-center justify-center w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl"
        style={{ height }}
      >
        <Activity className="w-12 h-12 text-white/30 mb-4" />
        <p className="text-white/50 text-sm font-medium">No equity data</p>
      </div>
    );
  }

  return (
    <div className="w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl p-4" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 10, left: -20, bottom: 5 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.1)" vertical={false} />
          <XAxis 
            dataKey="date" 
            stroke="rgba(255,255,255,0.5)" 
            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis 
            stroke="rgba(255,255,255,0.5)" 
            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value) => `$${value}`}
          />
          <Tooltip 
            contentStyle={{ 
              backgroundColor: 'rgba(0,0,0,0.8)', 
              borderColor: 'rgba(255,255,255,0.1)',
              borderRadius: '8px',
              color: '#fff'
            }}
            itemStyle={{ color: '#10b981' }}
          />
          <Line 
            type="monotone" 
            dataKey="equity" 
            stroke="#10b981" 
            strokeWidth={2} 
            dot={false}
            activeDot={{ r: 6, fill: '#10b981', stroke: '#000', strokeWidth: 2 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
