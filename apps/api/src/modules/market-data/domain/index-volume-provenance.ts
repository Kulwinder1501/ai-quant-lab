/**
 * What the vendor's index `volume` field actually is, established by measurement rather than assumption.
 *
 * NIFTY50 and BANKNIFTY spot indices are not traded instruments, so a non-zero volume on an index bar
 * cannot be that index's own turnover — and a field whose meaning is unknown must not silently become
 * VWAP input. The question was settled empirically against 157 trading days of 2026 data.
 *
 * ## Evidence
 *
 * 1. **Correlation with constituent cash volume: 0.877.** Daily NIFTY50 index volume against the summed
 *    daily cash volume of the 20 NIFTY50 constituents held locally, n=157.
 * 2. **Stable ratio: 2.141 (sd 0.303, ~14% CV).** Consistent with those 20 names being roughly 47% of
 *    the full 50-constituent share volume. A derived-but-unrelated field would not hold a stable ratio.
 * 3. **No expiry effect — the discriminating test.** Derivative turnover spikes violently on expiry;
 *    cash turnover does not. Mean index/cash ratio on NIFTY weekly-expiry Thursdays was **2.118**
 *    against **2.147** on other weekdays (n=31 vs 126), i.e. no spike at all, and a marginally *lower*
 *    maximum. This is what rules out the derivatives interpretation.
 * 4. **INDIAVIX reports 0% volume** across every bar, while every constituent-backed index reports
 *    non-zero. A volatility index has no constituent basket to aggregate — exactly what a
 *    constituent-derived field would do.
 * 5. Magnitudes are plausible for cash share counts (~415M shares/day across 50 large caps) and
 *    implausible for the alternative readings.
 *
 * ## What it therefore means, and the limit that matters
 *
 * The field behaves as an **aggregate share count across the index's constituent stocks**. That makes a
 * VWAP built from it an *activity-weighted index level* — a real, interpretable statistic — but
 * emphatically **not an execution benchmark**: nobody transacts at the index level, so it is not "the
 * average price participants paid" and cannot support execution-quality claims.
 *
 * One further limit constrains interpretation even as a feature: the weighting is by **share count, not
 * traded value and not index weight**. A cheap, heavily-traded constituent contributes more weight than
 * an expensive one with greater index influence, so the "activity" being weighted is skewed toward
 * low-priced names and does not track the index's own construction.
 *
 * ## Status of this conclusion
 *
 * Behavioural inference, not vendor documentation. The evidence is strong and mutually corroborating,
 * but Fyers has not confirmed the field definition, and a vendor may change it without notice — which
 * is why this carries a version string that must be stamped onto any research derived from it. The
 * BANKNIFTY case is consistent but weaker (correlation 0.540 against only 5 of its ~12 constituents),
 * so the NIFTY50 finding should not be assumed to transfer without its own check.
 *
 * Availability is also discontinuous: index volume is present from 2026 (99.6% of 1m bars, 98.9% of 5m)
 * and entirely absent in 2024 (0%). Any feature spanning that boundary is undefined on one side.
 */
export const indexVolumeProvenanceVersion = "INDEX_VOLUME_CONSTITUENT_AGGREGATE_V1";

export type IndexVolumeSemantics =
  /** Aggregate constituent cash share count; see the evidence above. */
  | "CONSTITUENT_CASH_SHARE_AGGREGATE"
  /** Reported zero on every bar; nothing to aggregate. */
  | "NOT_REPORTED"
  /** Genuinely traded instrument — the field is that instrument's own turnover. */
  | "OWN_TRADED_VOLUME"
  /** Not yet established for this symbol; must not be used as a VWAP input. */
  | "UNVERIFIED";

export interface IndexVolumeProvenance {
  readonly semantics: IndexVolumeSemantics;
  readonly provenanceVersion: string;
  /** True only where the field is that instrument's own turnover, i.e. a real execution benchmark. */
  readonly usableAsExecutionBenchmark: boolean;
  readonly note: string;
}

const constituentAggregate: IndexVolumeProvenance = {
  semantics: "CONSTITUENT_CASH_SHARE_AGGREGATE",
  provenanceVersion: indexVolumeProvenanceVersion,
  usableAsExecutionBenchmark: false,
  note: "Activity-weighted index level. Share-count weighted, not value- or index-weighted; "
    + "not an execution benchmark. Established behaviourally, not vendor-documented.",
};

const notReported: IndexVolumeProvenance = {
  semantics: "NOT_REPORTED",
  provenanceVersion: indexVolumeProvenanceVersion,
  usableAsExecutionBenchmark: false,
  note: "Volume reported as zero on every bar; no VWAP is computable.",
};

const ownVolume: IndexVolumeProvenance = {
  semantics: "OWN_TRADED_VOLUME",
  provenanceVersion: indexVolumeProvenanceVersion,
  usableAsExecutionBenchmark: true,
  note: "A genuinely traded instrument; volume is its own turnover and VWAP is an execution benchmark.",
};

const unverified: IndexVolumeProvenance = {
  semantics: "UNVERIFIED",
  provenanceVersion: indexVolumeProvenanceVersion,
  usableAsExecutionBenchmark: false,
  note: "Field semantics not established for this symbol; do not use as a VWAP input until measured.",
};

const bySymbol: Readonly<Record<string, IndexVolumeProvenance>> = Object.freeze({
  NIFTY50: constituentAggregate,
  // Consistent with NIFTY50 but measured against only 5 of ~12 constituents (corr 0.540), so it is
  // recorded at the same semantics with the weaker evidence noted rather than silently equated.
  BANKNIFTY: constituentAggregate,
  INDIAVIX: notReported,
  NIFTYBEES: ownVolume,
  BANKBEES: ownVolume,
});

/**
 * Resolves the volume semantics for a symbol, defaulting to UNVERIFIED.
 *
 * Defaults to refusing rather than assuming: an unmeasured symbol silently inheriting "aggregate" is
 * exactly how an unvalidated field becomes a VWAP input.
 */
export function indexVolumeProvenanceFor(symbol: string): IndexVolumeProvenance {
  return bySymbol[symbol.toUpperCase()] ?? unverified;
}
