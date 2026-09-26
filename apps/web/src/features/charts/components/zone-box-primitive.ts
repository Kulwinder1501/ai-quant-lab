import type {
  AutoscaleInfo,
  Coordinate,
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  Logical,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";
import type { CanvasRenderingTarget2D } from "fancy-canvas";

/**
 * One price zone (an ICT Order Block or Fair Value Gap) to draw as a shaded, bordered
 * rectangle on the candlestick pane -- lightweight-charts has no built-in "box", so this is a
 * minimal custom primitive (the officially documented extension point for exactly this).
 *
 * `time2` is deliberately the last loaded candle's time, not the zone's own end: these are
 * *active* zones (`activeFvgs`/`activeObs` from the ICT ledger already excludes anything
 * CONSUMED/INVALIDATED), so "still active" is drawn as "still open on the right edge", the same
 * way a trading terminal extends an untouched level to the current bar.
 *
 * `label` is carried on the box (used for the marker in `interactive-chart.tsx`'s tooltip-style
 * hover, if that's ever added) but deliberately NOT drawn inline on the canvas -- a symbol like
 * NIFTY50 can carry 50+ active zones at once, and a text label per box turned the chart into a
 * wall of overlapping text. Color alone (bullish/bearish, FVG/OB) plus the legend's counts is the
 * whole visual vocabulary now; `interactive-chart.tsx` also caps how many boxes reach here at all.
 */
export interface ZoneBox {
  readonly time1: Time;
  readonly time2: Time;
  readonly price1: number;
  readonly price2: number;
  readonly fillColor: string;
  readonly borderColor: string;
  readonly label: string;
}

class ZoneBoxRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly box: ZoneBox,
    private readonly x1: Coordinate | null,
    private readonly x2: Coordinate | null,
    private readonly y1: Coordinate | null,
    private readonly y2: Coordinate | null,
  ) {}

  draw(target: CanvasRenderingTarget2D): void {
    const { x1, x2, y1, y2, box } = this;
    if (x1 === null || x2 === null || y1 === null || y2 === null) return;

    target.useMediaCoordinateSpace(({ context }) => {
      const left = Math.min(x1, x2);
      const width = Math.max(x1, x2) - left;
      const top = Math.min(y1, y2);
      const height = Math.max(y1, y2) - top;
      if (width <= 0 || height <= 0) return;

      context.save();
      context.fillStyle = box.fillColor;
      context.fillRect(left, top, width, height);
      context.strokeStyle = box.borderColor;
      context.lineWidth = 1;
      context.setLineDash([3, 3]);
      context.strokeRect(left, top, width, height);
      context.restore();
    });
  }
}

class ZoneBoxPaneView implements IPrimitivePaneView {
  private x1: Coordinate | null = null;
  private x2: Coordinate | null = null;
  private y1: Coordinate | null = null;
  private y2: Coordinate | null = null;

  constructor(
    private readonly box: ZoneBox,
    private readonly chart: IChartApi,
    private readonly series: ISeriesApi<SeriesType>,
  ) {}

  update(): void {
    const timeScale = this.chart.timeScale();
    this.x1 = timeScale.timeToCoordinate(this.box.time1);
    this.x2 = timeScale.timeToCoordinate(this.box.time2);
    this.y1 = this.series.priceToCoordinate(this.box.price1);
    this.y2 = this.series.priceToCoordinate(this.box.price2);
  }

  renderer(): IPrimitivePaneRenderer | null {
    return new ZoneBoxRenderer(this.box, this.x1, this.x2, this.y1, this.y2);
  }
}

/** Draws a set of price zones as rectangles on whichever series it is attached to. */
export class ZoneBoxesPrimitive implements ISeriesPrimitive<Time> {
  private chart: IChartApi | null = null;
  private series: ISeriesApi<SeriesType> | null = null;
  private views: ZoneBoxPaneView[] = [];

  constructor(private readonly boxes: readonly ZoneBox[]) {}

  attached({ chart, series }: SeriesAttachedParameter<Time>): void {
    this.chart = chart as IChartApi;
    this.series = series as ISeriesApi<SeriesType>;
    this.views = this.boxes.map((box) => new ZoneBoxPaneView(box, this.chart!, this.series!));
  }

  detached(): void {
    this.chart = null;
    this.series = null;
    this.views = [];
  }

  updateAllViews(): void {
    this.views.forEach((view) => view.update());
  }

  paneViews(): readonly IPrimitivePaneView[] {
    return this.views;
  }

  /**
   * Without this, the chart auto-scales its price axis from the visible candles alone, and a
   * zone formed weeks ago at a price level the market hasn't revisited sits at a Y-coordinate
   * outside the rendered pane -- drawn, but never on screen. This is the library's own documented
   * hook for "expand the autoscale range to include visual elements drawn outside of the series'
   * current visible price range" (see `ISeriesPrimitiveBase.autoscaleInfo`), which the shipped
   * version never implemented. Real bug, not a styling nitpick: every bearish Order Block on
   * NIFTY50 was invisible because the whole set was priced above the candles' own auto-scaled
   * range during a sustained uptrend.
   *
   * Ignores the given logical range and spans every box unconditionally rather than only the
   * ones overlapping it -- converting a `Logical` bar index back to one of our `Time` values
   * would need the time scale's own lookup, and the box count here is small enough (tens, not
   * thousands) that a slightly wider-than-strictly-needed axis is the right tradeoff against a
   * zone silently going off-scale again the moment the visible window shifts.
   */
  autoscaleInfo(_startTimePoint: Logical, _endTimePoint: Logical): AutoscaleInfo | null {
    if (this.boxes.length === 0) return null;
    let minValue = Infinity;
    let maxValue = -Infinity;
    for (const box of this.boxes) {
      minValue = Math.min(minValue, box.price1, box.price2);
      maxValue = Math.max(maxValue, box.price1, box.price2);
    }
    if (!Number.isFinite(minValue) || !Number.isFinite(maxValue)) return null;
    return { priceRange: { minValue, maxValue } };
  }
}
