"use client";

import { useEffect, useRef } from "react";
import { CandlestickSeries, ColorType, createChart, HistogramSeries, type IChartApi, type Time } from "lightweight-charts";
import type { PriceBar } from "../types";

interface EquityChartProps {
  bars: PriceBar[];
  currency?: string;
  className?: string;
}

export function EquityChart({ bars, currency = "INR", className = "h-[360px] w-full" }: EquityChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Clean up existing chart
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
    }

    const container = chartContainerRef.current;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "rgb(148 163 184)",
        fontFamily: "var(--font-inter), 'Inter', system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(255, 255, 255, 0.05)" },
        horzLines: { color: "rgba(255, 255, 255, 0.05)" },
      },
      crosshair: {
        vertLine: {
          color: "rgba(148, 163, 184, 0.4)",
          width: 1,
          style: 3,
        },
        horzLine: {
          color: "rgba(148, 163, 184, 0.4)",
          width: 1,
          style: 3,
        },
      },
      rightPriceScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
        scaleMargins: {
          top: 0.1,
          bottom: 0.25,
        },
      },
      timeScale: {
        borderColor: "rgba(255, 255, 255, 0.1)",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 5,
        barSpacing: 6,
      },
      autoSize: true,
    });

    chartRef.current = chart;

    // Sort bars by date ascending
    const sortedBars = [...bars]
      .filter((b) => b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0)
      .sort((a, b) => a.barDate.localeCompare(b.barDate));

    if (sortedBars.length === 0) {
      return () => {
        chart.remove();
      };
    }

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "rgb(16 185 129)",
      downColor: "rgb(244 63 94)",
      borderVisible: false,
      wickUpColor: "rgb(16 185 129)",
      wickDownColor: "rgb(244 63 94)",
      priceFormat: {
        type: "price",
        precision: 2,
        minMove: 0.05,
      },
    });

    candleSeries.setData(
      sortedBars.map((b) => ({
        time: b.barDate as Time,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
      })),
    );

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {
        type: "volume",
      },
      priceScaleId: "", // Overlay scale
    });

    chart.priceScale("").applyOptions({
      scaleMargins: {
        top: 0.8,
        bottom: 0,
      },
    });

    volumeSeries.setData(
      sortedBars.map((b) => ({
        time: b.barDate as Time,
        value: b.volume,
        color: b.close >= b.open ? "rgba(16, 185, 129, 0.35)" : "rgba(244, 63, 94, 0.35)",
      })),
    );

    chart.timeScale().fitContent();

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [bars, currency]);

  return (
    <div className={`relative ${className}`}>
      {bars.length === 0 ? (
        <div className="flex h-full w-full items-center justify-center text-xs text-slate-500">
          No price bars available for this range
        </div>
      ) : (
        <div ref={chartContainerRef} className="h-full w-full" />
      )}
    </div>
  );
}
