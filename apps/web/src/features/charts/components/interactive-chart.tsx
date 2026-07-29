"use client";

import React, { useEffect, useRef, useMemo } from "react";
import { createChart, ColorType, IChartApi, ISeriesApi, Time, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from "lightweight-charts";
import type { ChartPayload } from "../domain";

interface InteractiveChartProps {
  payload: ChartPayload;
  activeIndicators: string[];
  showPatterns: boolean;
}

export function InteractiveChart({ payload, activeIndicators, showPatterns }: InteractiveChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  const candles = payload.candles || [];
  const indicators = payload.indicators || {};
  const patterns = payload.patterns || [];

  const hasRsi = activeIndicators.includes("RSI");
  const hasSma = activeIndicators.includes("SMA");
  const hasBb = activeIndicators.includes("BB");

  // Format data for lightweight-charts
  const ohlcData = useMemo(() => {
    return candles
      .map((c) => ({
        time: (new Date(c.timestamp).getTime() / 1000) as Time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [candles]);

  const volumeData = useMemo(() => {
    return candles
      .map((c) => ({
        time: (new Date(c.timestamp).getTime() / 1000) as Time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(16, 185, 129, 0.4)" : "rgba(244, 63, 94, 0.4)",
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [candles]);

  const smaData = useMemo(() => {
    if (!hasSma || !indicators.SMA) return [];
    return indicators.SMA
      .filter((p) => p.value !== undefined && p.value !== null)
      .map((p) => ({
        time: (new Date(p.timestamp).getTime() / 1000) as Time,
        value: p.value!,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [hasSma, indicators.SMA]);

  const { bbUpper, bbMiddle, bbLower } = useMemo(() => {
    if (!hasBb || !indicators.BB) return { bbUpper: [], bbMiddle: [], bbLower: [] };
    const upper: any[] = [];
    const middle: any[] = [];
    const lower: any[] = [];

    indicators.BB.forEach((p) => {
      const time = (new Date(p.timestamp).getTime() / 1000) as Time;
      if (p.upper !== undefined && p.upper !== null) upper.push({ time, value: p.upper });
      if (p.middle !== undefined && p.middle !== null) middle.push({ time, value: p.middle });
      if (p.lower !== undefined && p.lower !== null) lower.push({ time, value: p.lower });
    });

    return {
      bbUpper: upper.sort((a, b) => (a.time as number) - (b.time as number)),
      bbMiddle: middle.sort((a, b) => (a.time as number) - (b.time as number)),
      bbLower: lower.sort((a, b) => (a.time as number) - (b.time as number)),
    };
  }, [hasBb, indicators.BB]);

  const rsiData = useMemo(() => {
    if (!hasRsi || !indicators.RSI) return [];
    return indicators.RSI
      .filter((p) => p.value !== undefined && p.value !== null)
      .map((p) => ({
        time: (new Date(p.timestamp).getTime() / 1000) as Time,
        value: p.value!,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [hasRsi, indicators.RSI]);

  const markers = useMemo(() => {
    if (!showPatterns || patterns.length === 0) return [];
    return patterns.map((pat) => {
      const isBullish = pat.direction === "BULLISH";
      return {
        time: (new Date(pat.timestamp).getTime() / 1000) as Time,
        position: isBullish ? "belowBar" : "aboveBar",
        color: isBullish ? "#10b981" : "#f43f5e",
        shape: isBullish ? "arrowUp" : "arrowDown",
        text: pat.name || pat.type,
      };
    }).sort((a, b) => (a.time as number) - (b.time as number));
  }, [showPatterns, patterns]);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create chart
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#94a3b8",
        fontFamily: "'Inter', 'Roboto', sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(30, 41, 59, 0.5)" },
        horzLines: { color: "rgba(30, 41, 59, 0.5)" },
      },
      crosshair: {
        mode: 0,
        vertLine: {
          width: 1,
          color: "#38bdf8",
          style: 3,
        },
        horzLine: {
          width: 1,
          color: "#38bdf8",
          style: 3,
        },
      },
      rightPriceScale: {
        borderColor: "#334155",
        scaleMargins: hasRsi 
          ? { top: 0.1, bottom: 0.35 } 
          : { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: "#334155",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 10,
        barSpacing: 6,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      autoSize: true,
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true,
        mouseWheel: true,
        pinch: true,
      },
    });
    
    chartRef.current = chart;

    // Series
    const mainSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#10b981",
      downColor: "#f43f5e",
      borderVisible: false,
      wickUpColor: "#10b981",
      wickDownColor: "#f43f5e",
    });
    mainSeries.setData(ohlcData as any);
    
    if (markers.length > 0) {
      createSeriesMarkers(mainSeries, markers as any);
    }

    const volumeSeries = chart.addSeries(HistogramSeries, {
      priceFormat: {
        type: "volume",
      },
      priceScaleId: "", // Set as an overlay
    });
    chart.priceScale("").applyOptions({
      scaleMargins: hasRsi
        ? { top: 0.65, bottom: 0.2 } 
        : { top: 0.8, bottom: 0 },
    });
    volumeSeries.setData(volumeData);

    if (hasSma && smaData.length > 0) {
      const smaLine = chart.addSeries(LineSeries, {
        color: "#06b6d4",
        lineWidth: 2,
      });
      smaLine.setData(smaData);
    }

    if (hasBb) {
      if (bbUpper.length > 0) {
        chart.addSeries(LineSeries, {
          color: "rgba(16, 185, 129, 0.5)",
          lineWidth: 1,
          lineStyle: 2, // Dashed
        }).setData(bbUpper);
      }
      if (bbMiddle.length > 0) {
        chart.addSeries(LineSeries, {
          color: "rgba(59, 130, 246, 0.8)",
          lineWidth: 1,
        }).setData(bbMiddle);
      }
      if (bbLower.length > 0) {
        chart.addSeries(LineSeries, {
          color: "rgba(244, 63, 94, 0.5)",
          lineWidth: 1,
          lineStyle: 2, // Dashed
        }).setData(bbLower);
      }
    }

    // Add RSI Pane if present
    let rsiSeries: ISeriesApi<"Line"> | null = null;
    if (hasRsi && rsiData.length > 0) {
      const rsiScale = chart.priceScale("rsi");
      rsiScale.applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
        borderColor: "#334155",
      });

      const rsiLine = chart.addSeries(LineSeries, {
        color: "#f59e0b",
        lineWidth: 2,
        priceScaleId: "rsi",
      });
      rsiLine.setData(rsiData);
      rsiSeries = rsiLine as any;
      
      const rsiBaseOptions = {
        priceScaleId: "rsi",
        lineWidth: 1,
        lineStyle: 3, // Dotted
        lastValueVisible: false,
        priceLineVisible: false,
      };

      const overboughtLine = chart.addSeries(LineSeries, { ...rsiBaseOptions, color: "#f43f5e" } as any);
      const oversoldLine = chart.addSeries(LineSeries, { ...rsiBaseOptions, color: "#10b981" } as any);

      // Create static threshold lines for RSI
      const overboughtData = rsiData.map(d => ({ time: d.time, value: 70 }));
      const oversoldData = rsiData.map(d => ({ time: d.time, value: 30 }));
      
      overboughtLine.setData(overboughtData);
      oversoldLine.setData(oversoldData);
    }

    // Default to seeing the last 60 bars
    if (ohlcData.length > 60) {
      chart.timeScale().setVisibleLogicalRange({
        from: ohlcData.length - 60,
        to: ohlcData.length - 1,
      });
    } else {
      chart.timeScale().fitContent();
    }

    return () => {
      chart.remove();
    };
  }, [
    ohlcData, volumeData, hasSma, smaData, hasBb, bbUpper, bbMiddle, bbLower, 
    hasRsi, rsiData, markers, payload.timeframe
  ]);

  const handleZoom = (direction: 'in' | 'out') => {
    if (!chartRef.current) return;
    const timeScale = chartRef.current.timeScale();
    const currentLogicalRange = timeScale.getVisibleLogicalRange();
    if (currentLogicalRange) {
      const bars = currentLogicalRange.to - currentLogicalRange.from;
      const amount = direction === 'in' ? bars * 0.2 : -bars * 0.2;
      timeScale.setVisibleLogicalRange({
        from: currentLogicalRange.from + amount,
        to: currentLogicalRange.to - amount,
      });
    }
  };

  const handlePan = (direction: 'left' | 'right') => {
    if (!chartRef.current) return;
    const timeScale = chartRef.current.timeScale();
    const currentLogicalRange = timeScale.getVisibleLogicalRange();
    if (currentLogicalRange) {
      const bars = currentLogicalRange.to - currentLogicalRange.from;
      const amount = direction === 'left' ? -bars * 0.1 : bars * 0.1;
      timeScale.setVisibleLogicalRange({
        from: currentLogicalRange.from + amount,
        to: currentLogicalRange.to + amount,
      });
    }
  };

  const handleReset = () => {
    if (!chartRef.current) return;
    chartRef.current.timeScale().fitContent();
  };

  if (candles.length === 0) {
    return (
      <div className="flex h-96 flex-col items-center justify-center rounded-2xl border border-dashed border-white/10 bg-slate-950/40 p-8 text-center">
        <p className="text-base font-semibold text-slate-300">No chart candle data available</p>
        <p className="mt-1 text-xs text-slate-500">Select an instrument symbol and click &quot;Plot Chart&quot; to load historical OHLCV data.</p>
      </div>
    );
  }

  return (
    <div className="w-full rounded-2xl border border-cyan-500/30 bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950/90 p-4 shadow-2xl backdrop-blur-xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3 text-xs font-mono">
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-cyan-500/10 px-2.5 py-1 text-cyan-300 border border-cyan-500/30 font-extrabold">
            <span className="h-2 w-2 rounded-full bg-cyan-400 animate-pulse"></span>
            TRADINGVIEW LIGHTWEIGHT CHARTS
          </span>
          <span className="text-slate-400 hidden sm:inline">Professional Hardware Accelerated Visualization</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => handlePan('left')} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300" title="Pan Left">⬅️</button>
          <button onClick={() => handlePan('right')} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300" title="Pan Right">➡️</button>
          <button onClick={() => handleZoom('in')} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300" title="Zoom In">➕</button>
          <button onClick={() => handleZoom('out')} className="p-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-300" title="Zoom Out">➖</button>
          <button onClick={handleReset} className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-bold" title="Reset View">Reset</button>
        </div>
      </div>

      <div 
        ref={chartContainerRef} 
        className="w-full overflow-hidden rounded-xl h-[600px] cursor-crosshair active:cursor-grabbing"
      />
      <div className="mt-2 text-center text-[11px] text-slate-500 font-medium">
        💡 Tip: Drag chart to pan horizontally. Scroll mouse wheel to zoom in/out. Hover on flags to view pattern details.
      </div>
    </div>
  );
}
