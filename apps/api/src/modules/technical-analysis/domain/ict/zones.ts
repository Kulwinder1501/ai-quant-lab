import type { CausalCandle, ConfirmedPivot } from "./causal-pivot.js";
import type { IctStructureSnapshot } from "./structure.js";

export type ZoneLifecycleState = "FRESH" | "TOUCHED" | "PARTIALLY_FILLED" | "CONSUMED" | "INVALIDATED" | "INVERTED";

/**
 * The order-block taxonomy from lecture 7, which spends its whole length on the distinction.
 *
 * - `CLASSIC`   the familiar one: last opposing candle WITH an attached fair value gap.
 * - `ADVANCE`   the same shape with NO fair value gap -- "जस्ट एक कैंडल है जिसके ऊपर ना नीचे
 *               एफजी है, ये पूरी की पूरी कैंडल ऑर्डर ब्लॉक होगी". Never produced today: the
 *               creation path only fires alongside a newly created FVG, so `attachedFvgId` is
 *               always set. Classified for when that changes.
 * - `REJECTION` the block candle is mostly wick -- "इसके अंदर कक जो है 50 पर से ज्यादा है तो
 *               इसकी कक हम लेंगे". The doctrine also re-bases the zone onto 50% of the WICK
 *               rather than the candle; that part is deliberately NOT done here, because moving
 *               zone bounds changes which prices count as a tap.
 * - `MITIGATION` a FAILED block: price closed through it instead of rejecting from it, in a
 *               swing-FAILURE context. Explicitly a continuation pattern -- "मिटिगेशन ब्लॉक
 *               कंटिन्यू पैटर्न है".
 * - `BREAKER`   the same failure, except the swing was TAKEN rather than held. Lecture 7 says the
 *               two look identical and differ only in that -- "थोड़ा सा माइनर डिफरेंस है जो
 *               दोनों को अलग बनाता है" -- and this one is a reversal, not a continuation.
 * - `RECLAIM`   the last opposing candle immediately after a market-structure shift.
 */
export type OrderBlockKind = "CLASSIC" | "ADVANCE" | "REJECTION" | "MITIGATION" | "BREAKER" | "RECLAIM";

export interface FairValueGap {
  readonly id: string;
  readonly type: "BULLISH" | "BEARISH";
  readonly top: number;
  readonly bottom: number;
  readonly midpoint: number; // Consequent Encroachment (CE)
  readonly createdAtBarIndex: number;
  readonly createdAtBarTime: Date;
  readonly candle1Index: number;
  readonly candle3Index: number;
  /*
   * Fully immutable, deliberately -- including these three, which used to be mutated in place on
   * the SAME object as fill/state advanced bar over bar.
   *
   * The batch replay builder (`replay-builder.ts`) hands every bar's snapshot the LIVE zone object,
   * not a copy, and a backtest computes every snapshot before any of them is read. A snapshot taken
   * at bar 100 therefore held a reference to an object that kept changing underneath it as bars
   * 101..N ran, so reading `snapshots[100].zones.activeFvgs[0].fillPercentage` after the full replay
   * returned bar N's value, not bar 100's -- silently violating the "prefix-invariant by
   * construction" contract `computeIctSnapshotsForContexts` documents. The array holding the zones
   * was already re-copied per bar (see the top of `processCandle`); the objects inside it were not.
   * Every transition below now produces a NEW object instead of writing into this one, so a snapshot
   * already handed out can never change again.
   */
  readonly fillPercentage: number;
  readonly state: ZoneLifecycleState;
  readonly invertedAtBarIndex: number | null;
}

export interface OrderBlock {
  readonly id: string;
  readonly type: "BULLISH" | "BEARISH";
  readonly top: number;
  readonly bottom: number;
  readonly meanThreshold: number; // 50% of the OB body/range
  readonly createdAtBarIndex: number;
  readonly createdAtBarTime: Date;
  readonly obCandleIndex: number;
  readonly displacementCandleIndex: number;
  readonly attachedFvgId: string | null;
  readonly isExtreme: boolean;
  readonly isIdmAdjacent: boolean;
  /*
   * Immutable, deliberately.
   *
   * Reclassifying a failed block in place looked natural and leaked the future: the ledger hands
   * live zone objects to every snapshot, and the backtest builds all snapshots BEFORE replaying, so
   * a label written at bar 500 was visible to the strategy at bar 100. Measured: 34 BANKNIFTY
   * signals were attributed to a MITIGATION block in a run where the flag that lets mitigation
   * blocks exist was OFF. A failed block now becomes a NEW zone created at the failure bar, which
   * earlier snapshots cannot contain.
   */
  readonly kind: OrderBlockKind;
  /*
   * Also fully immutable now -- see `FairValueGap`'s equivalent note. TOUCHED used to be written into
   * this same object across bars, which leaked forward the same way `fillPercentage` did.
   */
  readonly state: ZoneLifecycleState;
}

export interface IctZoneSnapshot {
  readonly activeFvgs: readonly FairValueGap[];
  readonly activeObs: readonly OrderBlock[];
  readonly lastZoneEvent: {
    readonly zoneId: string;
    readonly zoneKind: "FVG" | "OB";
    readonly event: "CREATED" | "TOUCHED" | "PARTIALLY_FILLED" | "CONSUMED" | "INVALIDATED" | "INVERTED";
    readonly barIndex: number;
  } | null;
}

/**
 * Labels a freshly created block, per the lecture 7 taxonomy.
 *
 * Precedence is deliberate and only one branch can be reached today:
 *  1. `ADVANCE` -- structural (no gap at all), so it outranks any shape test. Unreachable while
 *     creation requires a newly created FVG.
 *  2. `REJECTION` -- a measured property of the block candle itself, so it beats a context label.
 *  3. `RECLAIM` -- context: the last opposing candle right after a structure shift.
 *  4. `CLASSIC` -- the default.
 *
 * The rejection test uses the wick FACING the trade (the lower wick of a bullish block, the upper
 * wick of a bearish one) rather than both wicks summed. A candle with one long wick on the wrong side
 * is not a rejection of anything, and pooling the two would label it as one.
 */
function classifyNewBlock(
  obCandle: CausalCandle,
  type: "BULLISH" | "BEARISH",
  hasAttachedFvg: boolean,
  structure: IctStructureSnapshot
): OrderBlockKind {
  if (!hasAttachedFvg) return "ADVANCE";

  const range = obCandle.high - obCandle.low;
  if (range > 0) {
    const facingWick =
      type === "BULLISH"
        ? Math.min(obCandle.open, obCandle.close) - obCandle.low
        : obCandle.high - Math.max(obCandle.open, obCandle.close);
    if (facingWick / range > 0.5) return "REJECTION";
  }

  if (structure.lastEvent?.type === "CHOCH") return "RECLAIM";
  return "CLASSIC";
}

export class IctZoneLedger {
  private fvgs: FairValueGap[] = [];
  private obs: OrderBlock[] = [];
  private lastEvent: IctZoneSnapshot["lastZoneEvent"] = null;
  /**
   * The most recent swing SWEEP, remembered across bars.
   *
   * Breaker and mitigation blocks are the same shape and differ only in whether the opposing swing
   * was TAKEN before the block failed -- lecture 7 calls it "थोड़ा सा माइनर डिफरेंस". That sweep
   * almost never lands on the same bar as the failure, and `structure.lastEvent` is null on most
   * bars, so testing it at the failure bar alone would label practically everything MITIGATION.
   */
  private lastSweep: { direction: "BULLISH" | "BEARISH"; barIndex: number } | null = null;

  constructor(
    private readonly displacementThreshold: number = 1.5,
    private readonly meanThresholdFraction: number = 0.5,
    private readonly invertedBlocksRemainPoi: boolean = false
  ) {}

  /**
   * Handles a gap price has closed clean through, which flips which side it serves.
   *
   * A bullish gap price closed BELOW is no longer demand; on the retest it is supply. The ledger used
   * to record that as `state = "INVERTED"` and leave the gap in the active list still advertising
   * `type: "BULLISH"` -- so the strategy was offered a long at a level that had just failed as
   * support. Gaps supply 85% of this strategy's entries, so this sat on the dominant path.
   *
   * Emitting a NEW gap dated to the inversion bar, rather than relabelling in place, is what makes
   * this cannot-leak: a snapshot taken earlier does not contain it -- the same reasoning as
   * `failBlock`. Returns both halves instead of mutating `fvg` or pushing directly, so the caller
   * controls exactly when each becomes visible to `this.fvgs`.
   *
   * This is a correctness fix, not a policy: the gap survived before and it survives now. What
   * changes is which side it is offered on.
   */
  private invertGap(
    fvg: FairValueGap,
    currentIndex: number,
    currentTime: Date
  ): { readonly updatedOriginal: FairValueGap; readonly flipped: FairValueGap } {
    const updatedOriginal: FairValueGap = { ...fvg, state: "INVALIDATED", invertedAtBarIndex: currentIndex };
    const flipped: FairValueGap = {
      ...fvg,
      id: `${fvg.id}-inv`,
      type: fvg.type === "BULLISH" ? "BEARISH" : "BULLISH",
      createdAtBarIndex: currentIndex,
      createdAtBarTime: currentTime,
      fillPercentage: 0,
      state: "FRESH",
      invertedAtBarIndex: null,
    };
    this.lastEvent = { zoneId: flipped.id, zoneKind: "FVG", event: "INVERTED", barIndex: currentIndex };
    return { updatedOriginal, flipped };
  }

  /**
   * Handles a block that price closed THROUGH -- the moment the doctrine and this engine part ways.
   *
   * The engine's reading is that the block was wrong, so it is invalidated and pruned. Lecture 7's
   * reading is that the block was wrong in a way that MATTERS: it is now a mitigation block if the
   * opposing swing merely failed (continuation -- "मिटिगेशन ब्लॉक कंटिन्यू पैटर्न है"), or a breaker
   * block if the swing was swept first (reversal). Either way price can trade back to it, from the
   * other side.
   *
   * "From the other side" is why this emits a NEW zone with the polarity FLIPPED rather than
   * relabelling the old one. Three things fall out of that which mutation got wrong:
   *
   *  - It cannot leak. The new zone is created at the failure bar, so a snapshot taken before that
   *    bar does not contain it. Relabelling in place was visible to every earlier snapshot.
   *  - Consumers need no special case. A bullish block that failed becomes a BEARISH zone, so the
   *    ordinary `type` match finds it on the correct side. Asking consumers to read `state` and
   *    flip the side themselves was a second place to get it wrong.
   *  - It gets an ending for free. Running the normal lifecycle for its new type retires it the
   *    usual way. Exempting inverted blocks from the lifecycle made them immortal, and because
   *    selection takes the first match in creation order they crowded out every fresh block: 1,081
   *    of 1,309 BANKNIFTY signals came from a mitigation block and not one from a fresh block.
   *
   * Returns both halves instead of mutating `ob` or pushing directly, for the same reason as
   * `invertGap`.
   */
  private failBlock(
    ob: OrderBlock,
    currentIndex: number,
    currentTime: Date
  ): { readonly updatedOriginal: OrderBlock; readonly flipped: OrderBlock | null } {
    const updatedOriginal: OrderBlock = { ...ob, state: "INVALIDATED" };
    this.lastEvent = { zoneId: ob.id, zoneKind: "OB", event: "INVALIDATED", barIndex: currentIndex };
    if (!this.invertedBlocksRemainPoi) return { updatedOriginal, flipped: null };

    /*
     * "Taken" means a sweep in the failed block's OWN direction at or after its block candle: a
     * bullish block whose rally swept a swing high and then reversed back down through it. A sweep
     * the other way, or one predating the block, says nothing about this block's failure.
     *
     * The window opens at the BLOCK CANDLE, not at the creation bar. A block is only recognised two
     * bars after its candle -- the displacement leg and the gap bar have to land first -- so keying
     * off `createdAtBarIndex` discarded any sweep performed by that displacement leg, which is the
     * commonest breaker geometry there is: the impulse takes the high, then fails back through the
     * block it came from. Measured: it labelled a hand-built breaker MITIGATION.
     */
    const swingWasTaken =
      this.lastSweep !== null &&
      this.lastSweep.direction === ob.type &&
      this.lastSweep.barIndex >= ob.obCandleIndex;

    const flipped: OrderBlock = {
      ...ob,
      id: `${ob.id}-inv`,
      type: ob.type === "BULLISH" ? "BEARISH" : "BULLISH",
      kind: swingWasTaken ? "BREAKER" : "MITIGATION",
      createdAtBarIndex: currentIndex,
      createdAtBarTime: currentTime,
      state: "FRESH",
    };
    this.lastEvent = { zoneId: flipped.id, zoneKind: "OB", event: "INVERTED", barIndex: currentIndex };
    return { updatedOriginal, flipped };
  }

  processCandle(
    candles: readonly CausalCandle[],
    currentIndex: number,
    structure: IctStructureSnapshot
  ): IctZoneSnapshot {
    this.lastEvent = null;
    const current = candles[currentIndex];

    /*
     * Detach from the arrays the previous bar handed out, before anything mutates them.
     *
     * The prune at the end of this method already builds fresh arrays, so bar N's snapshot holds the
     * array built at the end of bar N -- and bar N+1 then pushed the flipped zone straight into it.
     * A zone created at bar 3 duly turned up in the snapshot taken at bar 2. Copying costs two
     * reference-only array copies per bar.
     */
    this.fvgs = [...this.fvgs];
    this.obs = [...this.obs];

    if (structure.lastEvent?.type === "SWEEP") {
      this.lastSweep = { direction: structure.lastEvent.direction, barIndex: currentIndex };
    }

    // 1. Detect 3-bar Fair Value Gap on current bar (currentIndex = candle 3)
    let newlyCreatedFvg: FairValueGap | null = null;
    if (currentIndex >= 2) {
      const c1 = candles[currentIndex - 2];
      const c2 = candles[currentIndex - 1];
      const c3 = current;

      // Bullish FVG: Low of candle 3 > High of candle 1
      if (c3.low > c1.high) {
        const top = c3.low;
        const bottom = c1.high;
        const fvg: FairValueGap = {
          id: `fvg-bullish-${currentIndex}`,
          type: "BULLISH",
          top,
          bottom,
          midpoint: (top + bottom) / 2,
          createdAtBarIndex: currentIndex,
          createdAtBarTime: c3.openTime,
          candle1Index: currentIndex - 2,
          candle3Index: currentIndex,
          fillPercentage: 0,
          state: "FRESH",
          invertedAtBarIndex: null,
        };
        this.fvgs.push(fvg);
        newlyCreatedFvg = fvg;
        this.lastEvent = {
          zoneId: fvg.id,
          zoneKind: "FVG",
          event: "CREATED",
          barIndex: currentIndex,
        };
      }
      // Bearish FVG: High of candle 3 < Low of candle 1
      else if (c3.high < c1.low) {
        const top = c1.low;
        const bottom = c3.high;
        const fvg: FairValueGap = {
          id: `fvg-bearish-${currentIndex}`,
          type: "BEARISH",
          top,
          bottom,
          midpoint: (top + bottom) / 2,
          createdAtBarIndex: currentIndex,
          createdAtBarTime: c3.openTime,
          candle1Index: currentIndex - 2,
          candle3Index: currentIndex,
          fillPercentage: 0,
          state: "FRESH",
          invertedAtBarIndex: null,
        };
        this.fvgs.push(fvg);
        newlyCreatedFvg = fvg;
        this.lastEvent = {
          zoneId: fvg.id,
          zoneKind: "FVG",
          event: "CREATED",
          barIndex: currentIndex,
        };
      }
    }

    // 2. Detect Order Block
    if (currentIndex >= 2 && newlyCreatedFvg) {
      const displacementIndex = currentIndex - 1;
      const obIndex = currentIndex - 2;
      const displacementCandle = candles[displacementIndex];
      const obCandle = candles[obIndex];

      const body = Math.abs(displacementCandle.close - displacementCandle.open);
      const prevBody = Math.abs(obCandle.close - obCandle.open) || 1;

      if (body >= prevBody * this.displacementThreshold) {
        const isBullishDisplacement = displacementCandle.close > displacementCandle.open;
        const wasBearish = obCandle.close < obCandle.open;
        const wasBullish = obCandle.close > obCandle.open;

        if (isBullishDisplacement && wasBearish && newlyCreatedFvg.type === "BULLISH") {
          const top = obCandle.high;
          const bottom = obCandle.low;
          const ob: OrderBlock = {
            id: `ob-bullish-${currentIndex}`,
            type: "BULLISH",
            top,
            bottom,
            meanThreshold: bottom + (top - bottom) * this.meanThresholdFraction,
            createdAtBarIndex: currentIndex,
            createdAtBarTime: current.openTime,
            obCandleIndex: obIndex,
            displacementCandleIndex: displacementIndex,
            attachedFvgId: newlyCreatedFvg.id,
            isExtreme: structure.lastHL ? obCandle.low <= structure.lastHL.price : true,
            isIdmAdjacent: structure.idm ? Math.abs(obCandle.low - structure.idm.price) / obCandle.low < 0.005 : false,
            kind: classifyNewBlock(obCandle, "BULLISH", true, structure),
            state: "FRESH",
          };
          this.obs.push(ob);
          this.lastEvent = {
            zoneId: ob.id,
            zoneKind: "OB",
            event: "CREATED",
            barIndex: currentIndex,
          };
        } else if (!isBullishDisplacement && wasBullish && newlyCreatedFvg.type === "BEARISH") {
          const top = obCandle.high;
          const bottom = obCandle.low;
          const ob: OrderBlock = {
            id: `ob-bearish-${currentIndex}`,
            type: "BEARISH",
            top,
            bottom,
            meanThreshold: bottom + (top - bottom) * this.meanThresholdFraction,
            createdAtBarIndex: currentIndex,
            createdAtBarTime: current.openTime,
            obCandleIndex: obIndex,
            displacementCandleIndex: displacementIndex,
            attachedFvgId: newlyCreatedFvg.id,
            isExtreme: structure.lastLH ? obCandle.high >= structure.lastLH.price : true,
            isIdmAdjacent: structure.idm ? Math.abs(obCandle.high - structure.idm.price) / obCandle.high < 0.005 : false,
            kind: classifyNewBlock(obCandle, "BEARISH", true, structure),
            state: "FRESH",
          };
          this.obs.push(ob);
          this.lastEvent = {
            zoneId: ob.id,
            zoneKind: "OB",
            event: "CREATED",
            barIndex: currentIndex,
          };
        }
      }
    }

    // 3. Update FVG Lifecycle
    // Builds a brand new array rather than mutating in place -- see the `FairValueGap` docstring for
    // why. `invertGap` returns both halves instead of pushing, so the flipped gap is appended once,
    // after this pass, and its own creation bar is naturally exempt from being processed by it.
    {
      const nextFvgs: FairValueGap[] = [];
      const bornThisBar: FairValueGap[] = [];
      for (const fvg of this.fvgs) {
        if (fvg.state === "INVALIDATED" || fvg.state === "CONSUMED" || fvg.createdAtBarIndex === currentIndex) {
          nextFvgs.push(fvg);
          continue;
        }

        const gapHeight = fvg.top - fvg.bottom;
        const touches =
          gapHeight > 0 &&
          (fvg.type === "BULLISH"
            ? current.low <= fvg.top && current.high >= fvg.bottom
            : current.high >= fvg.bottom && current.low <= fvg.top);
        if (!touches) {
          nextFvgs.push(fvg);
          continue;
        }

        const penetration =
          fvg.type === "BULLISH" ? Math.max(0, fvg.top - current.low) : Math.max(0, current.high - fvg.bottom);
        const pct = Math.max(fvg.fillPercentage, Math.min(1.0, penetration / gapHeight));
        const inverts = fvg.type === "BULLISH" ? current.close < fvg.bottom : current.close > fvg.top;

        if (inverts) {
          const { updatedOriginal, flipped } = this.invertGap(fvg, currentIndex, current.openTime);
          nextFvgs.push(updatedOriginal);
          bornThisBar.push(flipped);
        } else {
          const nextState: ZoneLifecycleState = pct >= 1.0 ? "CONSUMED" : pct > 0 ? "PARTIALLY_FILLED" : fvg.state;
          nextFvgs.push(pct === fvg.fillPercentage && nextState === fvg.state ? fvg : { ...fvg, fillPercentage: pct, state: nextState });
        }
      }
      this.fvgs = [...nextFvgs, ...bornThisBar];
    }

    // 4. Update Order Block Lifecycle -- same copy-on-write shape as the FVG pass above.
    {
      const nextObs: OrderBlock[] = [];
      const bornThisBar: OrderBlock[] = [];
      for (const ob of this.obs) {
        if (ob.state === "INVALIDATED" || ob.state === "CONSUMED" || ob.createdAtBarIndex === currentIndex) {
          nextObs.push(ob);
          continue;
        }

        const touches = ob.type === "BULLISH" ? current.low <= ob.top : current.high >= ob.bottom;
        if (!touches) {
          nextObs.push(ob);
          continue;
        }

        const fails = ob.type === "BULLISH" ? current.close < ob.meanThreshold : current.close > ob.meanThreshold;
        if (fails) {
          const { updatedOriginal, flipped } = this.failBlock(ob, currentIndex, current.openTime);
          nextObs.push(updatedOriginal);
          if (flipped) bornThisBar.push(flipped);
        } else {
          nextObs.push(ob.state === "TOUCHED" ? ob : { ...ob, state: "TOUCHED" });
          this.lastEvent = { zoneId: ob.id, zoneKind: "OB", event: "TOUCHED", barIndex: currentIndex };
        }
      }
      this.obs = [...nextObs, ...bornThisBar];
    }

    /*
     * Drop dead zones from the master lists rather than filtering them out on every bar.
     *
     * `this.fvgs` and `this.obs` were never pruned, so INVALIDATED and CONSUMED zones accumulated
     * forever. Two costs, both quadratic over a run: the snapshot filtered the full history on EVERY
     * bar, and it allocated a fresh array each time which the snapshot then retained. Together with
     * the pivot history this is what OOM'd a 10,405-bar run at a 4GB heap.
     *
     * Behaviour-preserving: dead zones were already excluded from the snapshot, and the processing
     * loops above already `continue` past them. Nothing reads a zone once it is invalidated or
     * consumed -- `lastZoneEvent` refers to zones by id, not by reference.
     */
    this.fvgs = this.fvgs.filter((f) => f.state !== "INVALIDATED" && f.state !== "CONSUMED");
    this.obs = this.obs.filter((o) => o.state !== "INVALIDATED" && o.state !== "CONSUMED");

    return {
      activeFvgs: this.fvgs,
      activeObs: this.obs,
      lastZoneEvent: this.lastEvent,
    };
  }
}
