import { describe, expect, it } from "vitest";
import {
  bindSealedResolver,
  DecisionContextError,
  sealDecisionContext,
  SealedContextViolation,
  type BaseDecisionContext,
} from "./decision-context.js";
import { InMemorySnapshotRegistry } from "../../platform/snapshot/snapshot-registry.js";
import { snapshotRefFor } from "../../platform/snapshot/snapshot-ref.js";

const decisionAt = new Date("2026-08-31T09:46:00.000Z");
const evaluationAt = new Date("2026-08-31T09:46:08.000Z");
const sealedContent = { instrumentId: "instrument-1", bars: [24_300, 24_305, 24_312] };

function context(overrides: Partial<BaseDecisionContext> = {}): BaseDecisionContext {
  return {
    decisionId: "decision-1",
    decisionAt,
    evaluationAt,
    schedulerLagMs: 8_000,
    instants: {
      eventAt: new Date("2026-08-31T09:45:00.000Z"),
      knownAt: new Date("2026-08-31T09:45:59.000Z"),
      dataThrough: new Date("2026-08-31T09:45:59.999Z"),
      dataThroughConvention: "CLOSE_LABELLED",
      earliestExecutionAt: new Date("2026-08-31T09:47:00.000Z"),
      referenceAt: new Date("2026-08-31T09:47:00.000Z"),
    },
    snapshotRef: snapshotRefFor(sealedContent),
    policyVersions: { GRID: "GRID_POLICY_V1", TAPE: "TAPE_LIVENESS_V1" },
    ...overrides,
  };
}

describe("sealing a decision context", () => {
  it("freezes the context and everything reachable from it", () => {
    /*
     * Freezing is necessary and not sufficient -- see the resolver tests below -- but a context whose
     * nested policy map or snapshot ref could still be edited would let a later stage rewrite the
     * record of what the earlier ones saw.
     */
    const sealed = sealDecisionContext(context());

    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.instants)).toBe(true);
    expect(Object.isFrozen(sealed.policyVersions)).toBe(true);
    expect(Object.isFrozen(sealed.snapshotRef)).toBe(true);
  });

  it("refuses dataThrough at or after decisionAt", () => {
    /*
     * The leakage rule. Equality admits the bar that closes *at* decisionAt -- the bar the decision is
     * about -- which is post-decision information (I10). The scalp harness derives
     * `dataThrough = decisionAt - 1ms` for exactly this reason.
     */
    expect(() => sealDecisionContext(context({
      instants: { ...context().instants, dataThrough: decisionAt },
    }))).toThrow(/strictly before decisionAt/);

    expect(() => sealDecisionContext(context({
      instants: { ...context().instants, dataThrough: new Date(decisionAt.getTime() + 1) },
    }))).toThrow(/post-decision information \(I10\)/);
  });

  it("accepts dataThrough one millisecond before, which is what the harness produces", () => {
    expect(() => sealDecisionContext(context())).not.toThrow();
  });

  it("validates schedulerLagMs against the clocks it describes", () => {
    /*
     * Stored *and* checked. A lag that disagrees with its own timestamps is a corrupt record, and a
     * corrupt record is worse than a missing field because it will be trusted -- someone will chart
     * scheduler health from it.
     */
    expect(() => sealDecisionContext(context({ schedulerLagMs: 500 })))
      .toThrow(/but evaluationAt - decisionAt is 8000/);
  });

  it("never lets lag move decisionAt", () => {
    // Replay depends on the grid-anchored value; a 45-second wakeup is still the 09:46 slot.
    const late = sealDecisionContext(context({
      evaluationAt: new Date(decisionAt.getTime() + 45_000),
      schedulerLagMs: 45_000,
    }));

    expect(late.decisionAt.toISOString()).toBe(decisionAt.toISOString());
    expect(late.schedulerLagMs).toBe(45_000);
  });

  it("refuses an evaluation that precedes its own grid slot", () => {
    expect(() => sealDecisionContext(context({
      evaluationAt: new Date(decisionAt.getTime() - 1_000),
      schedulerLagMs: -1_000,
    }))).toThrow(/before it existed/);
  });

  it("refuses a context with no policy versions", () => {
    /*
     * I20 requires every paper trade to be fully replayable, and a replay cannot know which rules were
     * in force from an empty set. Refusing here costs a line; discovering it at replay costs the
     * session, which is gone by then.
     */
    expect(() => sealDecisionContext(context({ policyVersions: {} })))
      .toThrow(/must record the policy versions/);
  });

  it("refuses a blank decisionId and an invalid clock", () => {
    expect(() => sealDecisionContext(context({ decisionId: "  " }))).toThrow(DecisionContextError);
    expect(() => sealDecisionContext(context({ decisionAt: new Date("nope") }))).toThrow(/valid Date/);
  });

  it("inherits the PIT instant rules rather than restating them", () => {
    // `sealPitInstants` already refuses acting at or before the instant of knowing; the context does
    // not re-implement that check, so a change to the rule cannot leave the two disagreeing.
    expect(() => sealDecisionContext(context({
      instants: { ...context().instants, earliestExecutionAt: context().instants.knownAt },
    }))).toThrow(/strictly after knownAt/);
  });
});

describe("sealed resolution (I25, I26)", () => {
  async function bound() {
    const registry = new InMemorySnapshotRegistry();
    const snapshotRef = await registry.seal(sealedContent);
    const sealed = sealDecisionContext(context({ snapshotRef }));
    return { registry, resolver: bindSealedResolver({ context: sealed, registry }), sealed };
  }

  it("resolves the sealed bytes without being told which snapshot", async () => {
    /*
     * The shape is the point. `resolve()` takes no argument, so a stage has no way to express "the
     * latest one" -- I26 becomes a missing parameter rather than a rule someone has to remember. A
     * runtime check on a ref the stage supplies can be forgotten; an absent parameter cannot.
     */
    const { resolver } = await bound();

    expect(await resolver.resolve()).toContain("24312");
    expect(resolver.resolve.length).toBe(0);
  });

  it("refuses a different snapshot even when the registry holds it", async () => {
    /*
     * The realistic violation: the newer data genuinely exists and resolving it would succeed. Only
     * the binding refuses it.
     */
    const { registry, resolver } = await bound();
    const newer = await registry.seal({ ...sealedContent, bars: [24_300, 24_305, 24_312, 24_318] });

    expect(await registry.has(newer)).toBe(true);
    expect(() => resolver.assertResolvable(newer)).toThrow(SealedContextViolation);
    expect(() => resolver.assertResolvable(newer)).toThrow(/no stage may resolve a different or newer version \(I26\)/);
  });

  it("accepts the sealed ref, including an equal one rebuilt from content", async () => {
    // Content addressing means an independently derived ref for the same content is the same ref, so
    // an adapter that recomputed rather than passed it through is not a violation.
    const { resolver } = await bound();

    expect(() => resolver.assertResolvable(snapshotRefFor(sealedContent))).not.toThrow();
  });

  it("exposes the ref for logging but gives no way to choose one", async () => {
    const { resolver, sealed } = await bound();

    expect(resolver.snapshotRef).toEqual(sealed.snapshotRef);
    // No registry, and no resolve-by-ref: the capability a stage receives cannot reach other data.
    expect(Object.keys(resolver).sort()).toEqual(["assertResolvable", "resolve", "snapshotRef"]);
    expect(Object.isFrozen(resolver)).toBe(true);
  });

  it("still fails loudly when the sealed snapshot is missing from the registry", async () => {
    /*
     * A lost snapshot must not read as an empty context. A decision replayed against nothing looks
     * like a legitimate no-op, which is the conflation the registry contract refuses by throwing.
     */
    const registry = new InMemorySnapshotRegistry();
    const sealed = sealDecisionContext(context({ snapshotRef: snapshotRefFor({ never: "sealed" }) }));
    const resolver = bindSealedResolver({ context: sealed, registry });

    await expect(resolver.resolve()).rejects.toThrow(/not in this registry/);
  });
});
