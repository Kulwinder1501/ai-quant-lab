"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  createSeriesMarkers,
  HistogramSeries,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { Eye, EyeOff } from "lucide-react";
import type { EventFlagRecord, LevelItem, PriceBar } from "../types";

interface EquityChartProps {
  bars: PriceBar[];
  currency?: string;
  className?: string;
  levels?: LevelItem[];
  events?: EventFlagRecord[];
}

export function EquityChart({
  bars,
  currency = "INR",
  className = "h-[360px] w-full",
  levels,
  events,
}: EquityChartProps) {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);

  const [showLevels, setShowLevels] = useState(true);

  // Initialize and update chart bars
  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Clean up existing chart
    if (chartRef.current) {
      chartRef.current.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      priceLinesRef.current = [];
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

    candleSeriesRef.current = candleSeries;

    const markersPlugin = createSeriesMarkers(candleSeries);
    markersPluginRef.current = markersPlugin;

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
      candleSeriesRef.current = null;
      priceLinesRef.current = [];
      markersPluginRef.current = null;
    };
  }, [bars, currency]);

  // Manage event flag markers on chart
  useEffect(() => {
    const plugin = markersPluginRef.current;
    if (!plugin) return;

    if (!events || events.length === 0 || bars.length === 0) {
      plugin.setMarkers([]);
      return;
    }

    const barDates = new Set(bars.map((b) => b.barDate));
    const sortedEvents = [...events]
      .filter((e) => barDates.has(e.event_date))
      .sort((a, b) => a.event_date.localeCompare(b.event_date));

    const eventsByDate = new Map<string, EventFlagRecord[]>();
    for (const evt of sortedEvents) {
      const list = eventsByDate.get(evt.event_date) ?? [];
      list.push(evt);
      eventsByDate.set(evt.event_date, list);
    }

    const formatEventText = (evt: EventFlagRecord): string => {
      switch (evt.kind) {
        case "RESULTS_PUBLISHED":
        case "RESULTS_DATE_UPCOMING":
          return "Results";
        case "CORPORATE_ACTION":
          return "Corp Act";
        case "LARGE_MOVE_DAY":
          return "Move";
        case "MATERIAL_NEGATIVE":
          return "Negative";
        case "ORDER_WIN":
          return "Order";
        case "REGULATORY":
          return "Reg";
        case "MANAGEMENT":
          return "Mgmt";
        default:
          return evt.headline.length > 8 ? `${evt.headline.slice(0, 7)}…` : evt.headline;
      }
    };

    const markers: SeriesMarker<Time>[] = [];
    for (const [date, dayEvents] of eventsByDate.entries()) {
      if (dayEvents.length > 1) {
        // Clustered on same date: render single consolidated marker
        const hasManual = dayEvents.some((e) => e.origin === "MANUAL");
        markers.push({
          time: date as Time,
          position: hasManual ? "aboveBar" : "belowBar",
          color: hasManual ? "rgb(245 158 11)" : "rgb(6 182 212)",
          shape: hasManual ? "arrowDown" : "circle",
          text: `${dayEvents.length} events`,
        });
      } else {
        const evt = dayEvents[0];
        const isManual = evt.origin === "MANUAL";
        markers.push({
          time: date as Time,
          position: isManual ? "aboveBar" : "belowBar",
          color: isManual ? "rgb(245 158 11)" : "rgb(6 182 212)",
          shape: isManual ? "arrowDown" : "circle",
          text: formatEventText(evt),
        });
      }
    }

    plugin.setMarkers(markers);
  }, [events, bars]);

  // Manage descriptive price lines (Gate L9, Section 5.3)
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    // Clear existing price lines
    priceLinesRef.current.forEach((line) => {
      try {
        candleSeries.removePriceLine(line);
      } catch {}
    });
    priceLinesRef.current = [];

    if (!showLevels || !levels || levels.length === 0 || bars.length === 0) {
      return;
    }

    // Filter up to 6 strongest levels within 15% of latest close price
    const lastBar = bars[bars.length - 1];
    const latestClose = lastBar.close;

    const eligible = levels.filter((l) => {
      const distPct = Math.abs(l.price - latestClose) / latestClose;
      return distPct <= 0.15;
    });

    // Sort by strength descending (recency-weighted touches), limit to 6
    const topLevels = eligible.sort((a, b) => b.strength - a.strength).slice(0, 6);

    for (const lvl of topLevels) {
      const isSwing = lvl.kind === "SWING";
      const isSupport = lvl.side === "SUPPORT";

      // Neutral styling strictly enforced (no good/bad colors)
      let lineColor = "rgba(148, 163, 184, 0.65)"; // Slate neutral
      let lineStyle = LineStyle.Dotted;
      let lineWidth: 1 | 2 = 1;
      let labelTitle = `${lvl.source}: ₹${lvl.price.toFixed(2)}`;

      if (isSwing) {
        lineWidth = 2;
        if (isSupport) {
          lineColor = "rgba(56, 189, 248, 0.85)"; // Sky / Cyan
          lineStyle = LineStyle.Dashed;
          labelTitle = `Support ₹${lvl.price.toFixed(2)}`;
        } else {
          lineColor = "rgba(168, 85, 247, 0.85)"; // Violet
          lineStyle = LineStyle.LargeDashed;
          labelTitle = `Resistance ₹${lvl.price.toFixed(2)}`;
        }
      }

      try {
        const line = candleSeries.createPriceLine({
          price: lvl.price,
          color: lineColor,
          lineWidth,
          lineStyle,
          axisLabelVisible: true,
          title: labelTitle,
        });
        priceLinesRef.current.push(line);
      } catch {}
    }
  }, [bars, levels, showLevels]);

  return (
    <div className={`relative ${className}`}>
      {/* Levels Toggle Control */}
      {levels && levels.length > 0 && bars.length > 0 && (
        <div className="absolute top-2.5 left-2.5 z-10 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setShowLevels((prev) => !prev)}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-slate-900/90 px-2.5 py-1 text-xs font-mono text-slate-300 hover:text-white hover:bg-slate-800 backdrop-blur transition shadow-sm"
            aria-label="Toggle descriptive price levels"
          >
            {showLevels ? (
              <Eye className="size-3.5 text-cyan-400" />
            ) : (
              <EyeOff className="size-3.5 text-slate-500" />
            )}
            <span>Levels: {showLevels ? "Shown" : "Hidden"}</span>
          </button>
        </div>
      )}

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
