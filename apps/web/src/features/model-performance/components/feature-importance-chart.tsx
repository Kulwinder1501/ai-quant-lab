"use client";

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";
import { AlignLeft } from "lucide-react";

export interface FeatureImportanceData {
  feature: string;
  importance: number;
}

interface Props {
  data: FeatureImportanceData[];
  height?: number | string;
}

export function FeatureImportanceChart({ data, height = 400 }: Props) {
  if (!data || data.length === 0) {
    return (
      <div 
        className="flex flex-col items-center justify-center w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl"
        style={{ height }}
      >
        <AlignLeft className="w-12 h-12 text-white/30 mb-4" />
        <p className="text-white/50 text-sm font-medium">No feature data</p>
      </div>
    );
  }

  return (
    <div className="w-full bg-black/20 backdrop-blur-md border border-white/10 rounded-xl p-4" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart 
          data={data} 
          layout="vertical" 
          margin={{ top: 5, right: 30, left: 40, bottom: 5 }}
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
          <Bar dataKey="importance" fill="#f59e0b" radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
