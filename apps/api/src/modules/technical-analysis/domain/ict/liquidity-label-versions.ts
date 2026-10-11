/**
 * Generation-version constants for the liquidity research tables, so rows produced by the
 * defective legacy generators can never be silently mixed with rows from the corrected ones.
 *
 * Both columns are added (with DEFAULT 'v1-legacy' for every pre-existing row) by migration
 * `132-contact-label-versioning`.
 *
 * ## `liquidity_contact_labels.labeling_version`
 *
 * - `v1-legacy`: forward window started at `known_at_time`, which by the repo stamp convention
 *   (`causal-pivot.ts`) is the OPEN of the confirming bar -- so the confirming bar itself (before
 *   the level was observable) was inside the contact window. 5m SESSION_HIGH/LOW: 5646/5646
 *   "contacted", 0 breached. The "30s" horizon was computed from 1m bars (a 60s span), and
 *   `contact_time` was the touch bar's OPEN. Unsafe for any evaluation.
 * - `v2-causal`: window starts at the confirming bar's CLOSE (`known_at_time + timeframe`), never
 *   includes the confirming bar, uses only bars that close inside the horizon (so the finest honest
 *   horizon on 1m bars is 60s -- there is no 30s label), and `contact_time` is the touch bar's CLOSE.
 *
 * ## `liquidity_pool_candidates.candidate_version`
 *
 * - `v1-legacy`: PDH/PDL were re-registered on every bar after a breach (one level-day produced up
 *   to 1,725 rows; 5m BANKNIFTY PDL: 104,749 rows for 191 level-days) and the re-registering bar's
 *   own low/high was at/through the level (selection, not market behaviour).
 * - `v2-dedup`: one candidate per (instrument, timeframe, pool_type, price, session_date); a level
 *   breached in a session is never re-registered in that session. Enforced by a partial UNIQUE index.
 */
export const CANDIDATE_VERSION_LEGACY = "v1-legacy";
export const CANDIDATE_VERSION_CURRENT = "v2-dedup";
export const LABELING_VERSION_LEGACY = "v1-legacy";
export const LABELING_VERSION_CURRENT = "v2-causal";

export type CandidateVersion = typeof CANDIDATE_VERSION_LEGACY | typeof CANDIDATE_VERSION_CURRENT;
export type LabelingVersion = typeof LABELING_VERSION_LEGACY | typeof LABELING_VERSION_CURRENT;
