"use client";

import { LineChart, Line, ResponsiveContainer, YAxis } from "recharts";

export interface SparklineData {
  value: number;
}

interface Props {
  data: SparklineData[];
  color?: string;
  height?: number | string;
}

export function PnLSparkline({ data, color = "#10b981", height = 60 }: Props) {
  if (!data || data.length === 0) {
    return <div className="w-full bg-black/10 rounded" style={{ height }} />;
  }

  return (
    <div className="w-full" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
          <YAxis domain={['dataMin', 'dataMax']} hide />
          <Line 
            type="monotone" 
            dataKey="value" 
            stroke={color} 
            strokeWidth={2} 
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
