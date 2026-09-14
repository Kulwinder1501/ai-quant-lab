import type {
  CompressionExpansionDetails,
  PatternOrientation,
} from "../contracts.js";
import type { CandleLike } from "../pattern-context-calculator.js";

export interface CompressionExpansionCandidate {
  startIndex: number;
  detectedIndex: number;
  subtype: CompressionExpansionDetails["subtype"];
  orientation: PatternOrientation;
  compressionRatio: number | null;
  vcpContractionCount: number | null;
  patternHigh: number;
  patternLow: number;
}

export class CompressionExpansionEngine {
  detect(candles: readonly CandleLike[]): CompressionExpansionCandidate[] {
    if (candles.length < 2) return [];
    const candidates: CompressionExpansionCandidate[] = [];

    for (let i = 1; i < candles.length; i++) {
      const current = candles[i]!;
      const prev = candles[i - 1]!;
      const currentRange = current.high - current.low;
      const prevRange = prev.high - prev.low;

      // 1. Inside Bar checks
      const isInside = current.high <= prev.high && current.low >= prev.low;
      if (isInside) {
        let insideCount = 1;
        let startIdx = i - 1;

        if (i >= 2 && candles[i - 1]!.high <= candles[i - 2]!.high && candles[i - 1]!.low >= candles[i - 2]!.low) {
          insideCount = 2;
          startIdx = i - 2;
          if (i >= 3 && candles[i - 2]!.high <= candles[i - 3]!.high && candles[i - 2]!.low >= candles[i - 3]!.low) {
            insideCount = 3;
            startIdx = i - 3;
          }
        }

        const motherRange = candles[startIdx]!.high - candles[startIdx]!.low;
        // Null, not 1.0. A zero-range mother bar makes the ratio uncomputable, and 1.0 is a
        // legitimate value meaning "same width as the mother bar" -- the two must stay distinguishable.
        // The contract already permits null here.
        const compressionRatio = motherRange > 0 ? Number((currentRange / motherRange).toFixed(6)) : null;

        let subtype: CompressionExpansionDetails["subtype"] = "INSIDE_BAR";
        if (insideCount === 2) subtype = "DOUBLE_INSIDE_BAR";
        if (insideCount === 3) subtype = "TRIPLE_INSIDE_BAR";

        candidates.push({
          startIndex: startIdx,
          detectedIndex: i,
          subtype,
          orientation: "BIDIRECTIONAL",
          compressionRatio,
          vcpContractionCount: null,
          patternHigh: Math.max(...candles.slice(startIdx, i + 1).map((c) => c.high)),
          patternLow: Math.min(...candles.slice(startIdx, i + 1).map((c) => c.low)),
        });
      }

      // 2. NR4 (Narrowest Range of last 4 bars)
      if (i >= 3) {
        const r0 = candles[i]!.high - candles[i]!.low;
        const r1 = candles[i - 1]!.high - candles[i - 1]!.low;
        const r2 = candles[i - 2]!.high - candles[i - 2]!.low;
        const r3 = candles[i - 3]!.high - candles[i - 3]!.low;

        if (r0 < r1 && r0 < r2 && r0 < r3) {
          const maxR = Math.max(r1, r2, r3);
          const ratio = maxR > 0 ? Number((r0 / maxR).toFixed(6)) : null;
          candidates.push({
            startIndex: i - 3,
            detectedIndex: i,
            subtype: "NR4",
            orientation: "BIDIRECTIONAL",
            compressionRatio: ratio,
            vcpContractionCount: null,
            patternHigh: Math.max(...candles.slice(i - 3, i + 1).map((c) => c.high)),
            patternLow: Math.min(...candles.slice(i - 3, i + 1).map((c) => c.low)),
          });
        }
      }

      // 3. NR7 (Narrowest Range of last 7 bars)
      if (i >= 6) {
        const ranges: number[] = [];
        for (let j = i - 6; j <= i; j++) {
          ranges.push(candles[j]!.high - candles[j]!.low);
        }
        const currentR = ranges[6]!;
        const priorRanges = ranges.slice(0, 6);
        const isNr7 = priorRanges.every((r) => currentR < r);

        if (isNr7) {
          const maxR = Math.max(...priorRanges);
          const ratio = maxR > 0 ? Number((currentR / maxR).toFixed(6)) : null;
          candidates.push({
            startIndex: i - 6,
            detectedIndex: i,
            subtype: "NR7",
            orientation: "BIDIRECTIONAL",
            compressionRatio: ratio,
            vcpContractionCount: null,
            patternHigh: Math.max(...candles.slice(i - 6, i + 1).map((c) => c.high)),
            patternLow: Math.min(...candles.slice(i - 6, i + 1).map((c) => c.low)),
          });
        }
      }

      // 4. Volatility Contraction Pattern (VCP) over 6-12 bars
      // Successive contraction waves where Wave 1 depth > Wave 2 depth > Wave 3 depth
      if (i >= 9) {
        const wave1 = candles.slice(i - 9, i - 6);
        const wave2 = candles.slice(i - 6, i - 3);
        const wave3 = candles.slice(i - 3, i + 1);

        const depth1 = Math.max(...wave1.map((c) => c.high)) - Math.min(...wave1.map((c) => c.low));
        const depth2 = Math.max(...wave2.map((c) => c.high)) - Math.min(...wave2.map((c) => c.low));
        const depth3 = Math.max(...wave3.map((c) => c.high)) - Math.min(...wave3.map((c) => c.low));

        if (depth1 > depth2 && depth2 > depth3 && depth1 > 0) {
          const compressionRatio = Number((depth3 / depth1).toFixed(6));
          candidates.push({
            startIndex: i - 9,
            detectedIndex: i,
            subtype: "VCP",
            orientation: "UP",
            compressionRatio,
            vcpContractionCount: 3,
            patternHigh: Math.max(...candles.slice(i - 9, i + 1).map((c) => c.high)),
            patternLow: Math.min(...candles.slice(i - 9, i + 1).map((c) => c.low)),
          });
        }
      }

      // 5. Expansion (Current range > 2.0x 5-bar average range)
      if (i >= 5) {
        const priorAvgRange = candles.slice(i - 5, i).reduce((sum, c) => sum + (c.high - c.low), 0) / 5;
        if (priorAvgRange > 0 && currentRange >= priorAvgRange * 2.0) {
          const ratio = Number((currentRange / priorAvgRange).toFixed(6));
          const orientation: PatternOrientation = current.close > current.open ? "UP" : "DOWN";
          candidates.push({
            startIndex: i - 1,
            detectedIndex: i,
            subtype: "EXPANSION",
            orientation,
            compressionRatio: null,
            vcpContractionCount: null,
            patternHigh: current.high,
            patternLow: current.low,
          });
        }
      }
    }

    return candidates;
  }
}
