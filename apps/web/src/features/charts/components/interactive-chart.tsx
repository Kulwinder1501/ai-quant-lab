"use client";

import React, { useEffect, useRef, useMemo } from "react";
import { createChart, ColorType, IChartApi, LineStyle, Time, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from "lightweight-charts";
import type { CandlestickData, HistogramData, LineData, SeriesMarker } from "lightweight-charts";
import type { ChartPayload } from "../domain";
import { useAppStore } from "../../../stores/app-store";

interface InteractiveChartProps {
  payload: ChartPayload;
  activeIndicators: string[];
  showPatterns: boolean;
  /** Sizing for the chart container. Defaults to a self-supporting height for
   *  callers that don't constrain it; pass "h-full w-full" inside a flex row. */
  className?: string;
}

export function InteractiveChart({ payload, activeIndicators, showPatterns, className = "w-full h-full min-h-[300px]" }: InteractiveChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const theme = useAppStore((state) => state.theme);

  // The canvas is painted by JS, so it can't use Tailwind classes. Read the same
  // theme variables globals.css defines (they flip with data-theme) and build the
  // colour strings from them, so the chart tracks the app's light/dark toggle.
  const chartColors = useMemo(() => {
    const rgb = (name: string, fallback: string) => {
      if (typeof window === "undefined") return fallback;
      return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    };

    // Fallbacks mirror globals.css for the first paint, before the variables
    // resolve; the accent scales are only overridden in light, so their dark
    // values double as the fallback.
    const base = theme === "light"
      ? { text: "51 65 85", grid: "203 213 225", muted: "71 85 105" }
      : { text: "203 213 225", grid: "30 41 59", muted: "148 163 184" };

    const text = rgb("--chart-text", base.text);
    const grid = rgb("--chart-grid", base.grid);
    const muted = rgb("--chart-muted", base.muted);
    const cyan = rgb("--color-cyan-400", "34 211 238");
    const blue = rgb("--color-blue-400", "96 165 250");
    const amber = rgb("--color-amber-400", "251 191 36");
    const emerald = rgb("--color-emerald-500", "16 185 129");
    const rose = rgb("--color-rose-500", "244 63 94");

    return {
      text: `rgb(${text})`,
      grid: `rgb(${grid} / 0.45)`,
      crosshair: `rgb(${muted})`,
      border: `rgb(${grid})`,
      sma: `rgb(${cyan})`,
      bollingerMiddle: `rgb(${blue} / 0.75)`,
      bollingerUpper: `rgb(${emerald} / 0.5)`,
      bollingerLower: `rgb(${rose} / 0.5)`,
      rsi: `rgb(${amber})`,
      up: `rgb(${emerald})`,
      down: `rgb(${rose})`,
    };
  }, [theme]);

  const candles = useMemo(() => payload.candles || [], [payload.candles]);
  const indicators = useMemo(() => payload.indicators || {}, [payload.indicators]);
  const patterns = useMemo(() => payload.patterns || [], [payload.patterns]);

  const hasRsi = activeIndicators.includes("RSI");
  const hasSma = activeIndicators.includes("SMA");
  const hasBb = activeIndicators.includes("BB");

  // Format data for lightweight-charts
  const ohlcData = useMemo<CandlestickData<Time>[]>(() => {
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

  const volumeData = useMemo<HistogramData<Time>[]>(() => {
    return candles
      .map((c) => ({
        time: (new Date(c.timestamp).getTime() / 1000) as Time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(16, 185, 129, 0.4)" : "rgba(244, 63, 94, 0.4)",
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [candles]);

  const smaData = useMemo<LineData<Time>[]>(() => {
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
    const upper: LineData<Time>[] = [];
    const middle: LineData<Time>[] = [];
    const lower: LineData<Time>[] = [];

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

  const rsiData = useMemo<LineData<Time>[]>(() => {
    if (!hasRsi || !indicators.RSI) return [];
    return indicators.RSI
      .filter((p) => p.value !== undefined && p.value !== null)
      .map((p) => ({
        time: (new Date(p.timestamp).getTime() / 1000) as Time,
        value: p.value!,
      }))
      .sort((a, b) => (a.time as number) - (b.time as number));
  }, [hasRsi, indicators.RSI]);

  const markers = useMemo<SeriesMarker<Time>[]>(() => {
    if (!showPatterns) return [];
    
    const allMarkers: SeriesMarker<Time>[] = [];

    if (patterns && patterns.length > 0) {
      patterns.forEach((pat) => {
        const isBullish = pat.direction === "BULLISH";
        allMarkers.push({
          time: (new Date(pat.timestamp).getTime() / 1000) as Time,
          position: isBullish ? "belowBar" : "aboveBar",
          color: isBullish ? "#10b981" : "#f43f5e",
          shape: isBullish ? "arrowUp" : "arrowDown",
          text: pat.name || pat.type,
        });
      });
    }

    if (indicators.FVG) {
      indicators.FVG.forEach((fvg) => {
        const isBullish = fvg.type === "BULLISH";
        allMarkers.push({
          time: (new Date(fvg.timestamp).getTime() / 1000) as Time,
          position: isBullish ? "belowBar" : "aboveBar",
          color: isBullish ? "#10b981" : "#f43f5e",
          shape: "circle",
          text: "FVG",
        });
      });
    }

    if (indicators.BOS) {
      indicators.BOS.forEach((bos) => {
        const isBullish = bos.type === "BULLISH_BOS";
        allMarkers.push({
          time: (new Date(bos.timestamp).getTime() / 1000) as Time,
          position: isBullish ? "belowBar" : "aboveBar",
          color: isBullish ? "#3b82f6" : "#eab308",
          shape: "square",
          text: "BOS",
        });
      });
    }

    if (indicators.CHOCH) {
      indicators.CHOCH.forEach((choch) => {
        const isBullish = choch.type === "BULLISH_CHOCH";
        allMarkers.push({
          time: (new Date(choch.timestamp).getTime() / 1000) as Time,
          position: isBullish ? "belowBar" : "aboveBar",
          color: isBullish ? "#8b5cf6" : "#d946ef",
          shape: "arrowUp",
          text: "CHoCH",
        });
      });
    }

    if (indicators.LIQUIDITY_SWEEP) {
      indicators.LIQUIDITY_SWEEP.forEach((sweep) => {
        const isBullish = sweep.type === "BULLISH_SWEEP";
        allMarkers.push({
          time: (new Date(sweep.timestamp).getTime() / 1000) as Time,
          position: isBullish ? "belowBar" : "aboveBar",
          color: isBullish ? "#14b8a6" : "#f97316",
          shape: "arrowDown",
          text: "Sweep",
        });
      });
    }

    if (indicators.ORDER_BLOCK) {
      indicators.ORDER_BLOCK.forEach((ob) => {
        const isBullish = ob.type === "BULLISH_OB";
        allMarkers.push({
          time: (new Date(ob.timestamp).getTime() / 1000) as Time,
          position: isBullish ? "belowBar" : "aboveBar",
          color: isBullish ? "#0ea5e9" : "#fb923c",
          shape: "circle",
          text: "OB",
        });
      });
    }

    return allMarkers.sort((a, b) => (a.time as number) - (b.time as number));
  }, [showPatterns, patterns, indicators.FVG, indicators.BOS, indicators.CHOCH, indicators.LIQUIDITY_SWEEP, indicators.ORDER_BLOCK]);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create chart
    const chart = createChart(chartContainerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: chartColors.text,
        fontFamily: "var(--font-inter), 'Inter', system-ui, sans-serif",
      },
      grid: {
        vertLines: { color: chartColors.grid },
        horzLines: { color: chartColors.grid },
      },
      crosshair: {
        mode: 0,
        vertLine: {
          width: 1,
          color: chartColors.crosshair,
          style: 3,
        },
        horzLine: {
          width: 1,
          color: chartColors.crosshair,
          style: 3,
        },
      },
      rightPriceScale: {
        borderColor: chartColors.border,
        scaleMargins: hasRsi 
          ? { top: 0.1, bottom: 0.35 } 
          : { top: 0.1, bottom: 0.2 },
      },
      timeScale: {
        borderColor: chartColors.border,
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
      upColor: chartColors.up,
      downColor: chartColors.down,
      borderVisible: false,
      wickUpColor: chartColors.up,
      wickDownColor: chartColors.down,
    });
    mainSeries.setData(ohlcData);
    
    if (markers.length > 0) {
      createSeriesMarkers(mainSeries, markers);
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
        color: chartColors.sma,
        lineWidth: 2,
      });
      smaLine.setData(smaData);
    }

    if (hasBb) {
      if (bbUpper.length > 0) {
        chart.addSeries(LineSeries, {
          color: chartColors.bollingerUpper,
          lineWidth: 1,
          lineStyle: 2, // Dashed
        }).setData(bbUpper);
      }
      if (bbMiddle.length > 0) {
        chart.addSeries(LineSeries, {
          color: chartColors.bollingerMiddle,
          lineWidth: 1,
        }).setData(bbMiddle);
      }
      if (bbLower.length > 0) {
        chart.addSeries(LineSeries, {
          color: chartColors.bollingerLower,
          lineWidth: 1,
          lineStyle: 2, // Dashed
        }).setData(bbLower);
      }
    }

    // Add RSI Pane if present
    if (hasRsi && rsiData.length > 0) {
      // An overlay price scale only exists once a series is attached to it —
      // reaching for chart.priceScale("rsi") first throws "incorrect ID: rsi".
      const rsiLine = chart.addSeries(LineSeries, {
        color: chartColors.rsi,
        lineWidth: 2,
        priceScaleId: "rsi",
      });
      rsiLine.setData(rsiData);

      chart.priceScale("rsi").applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
        borderColor: chartColors.border,
      });

      const rsiBaseOptions = {
        priceScaleId: "rsi",
        lineWidth: 1 as const,
        lineStyle: LineStyle.Dotted,
        lastValueVisible: false,
        priceLineVisible: false,
      };

      const overboughtLine = chart.addSeries(LineSeries, { ...rsiBaseOptions, color: "#f43f5e" });
      const oversoldLine = chart.addSeries(LineSeries, { ...rsiBaseOptions, color: "#10b981" });

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
    hasRsi, rsiData, markers, payload.timeframe, chartColors
  ]);

  const handleReset = () => {
    if (!chartRef.current) return;
    chartRef.current.timeScale().fitContent();
  };

  if (candles.length === 0) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-8 text-center">
        <p className="text-base font-semibold text-slate-400">No chart candle data available</p>
      </div>
    );
  }

  return (
    <div
      ref={chartContainerRef}
      className={`${className} cursor-crosshair active:cursor-grabbing`}
    />
  );
}
