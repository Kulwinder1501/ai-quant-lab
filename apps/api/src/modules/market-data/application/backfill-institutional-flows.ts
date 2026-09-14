import type { InstitutionalFlow } from "../domain/institutional-flow.js";

export interface HistoricalInstitutionalFlowSource {
  fetch(): Promise<InstitutionalFlow[]>;
}

export interface HistoricalInstitutionalFlowStore {
  findByDate(date: Date): Promise<InstitutionalFlow | null>;
  upsert(flow: InstitutionalFlow): Promise<void>;
}

export interface BackfillInstitutionalFlowsResult {
  received: number;
  eligible: number;
  inserted: number;
  preserved: number;
  firstDate: string | null;
  lastDate: string | null;
}

export class BackfillInstitutionalFlows {
  constructor(
    private readonly source: HistoricalInstitutionalFlowSource,
    private readonly store: HistoricalInstitutionalFlowStore,
  ) {}

  async execute(input: { from: Date; to: Date }): Promise<BackfillInstitutionalFlowsResult> {
    if (input.from.getTime() > input.to.getTime()) throw new Error("Backfill `from` must not be after `to`.");
    const received = await this.source.fetch();
    const unique = new Map<string, InstitutionalFlow>();
    for (const flow of received) {
      if (flow.date < input.from || flow.date > input.to) continue;
      const key = flow.date.toISOString().slice(0, 10);
      const prior = unique.get(key);
      if (prior && (prior.fiiCashNetCr !== flow.fiiCashNetCr || prior.diiCashNetCr !== flow.diiCashNetCr)) {
        throw new Error(`Historical FII/DII archive contains conflicting real rows for ${key}.`);
      }
      unique.set(key, flow);
    }

    const eligible = [...unique.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
    let inserted = 0;
    let preserved = 0;
    for (const flow of eligible) {
      // Existing rows, particularly direct NSE rows, have stronger provenance.
      // Never downgrade or silently revise them during a third-party backfill.
      const existing = await this.store.findByDate(flow.date);
      if (existing) {
        const differs = (
          existing.fiiCashNetCr !== null && flow.fiiCashNetCr !== null &&
          Math.abs(existing.fiiCashNetCr - flow.fiiCashNetCr) > 0.11
        ) || (
          existing.diiCashNetCr !== null && flow.diiCashNetCr !== null &&
          Math.abs(existing.diiCashNetCr - flow.diiCashNetCr) > 0.11
        );
        if (differs) {
          throw new Error(
            `Historical FII/DII archive disagrees with the preserved first-party row for ${flow.date.toISOString().slice(0, 10)}.`,
          );
        }
        preserved += 1;
        continue;
      }
      await this.store.upsert(flow);
      inserted += 1;
    }

    return {
      received: received.length,
      eligible: eligible.length,
      inserted,
      preserved,
      firstDate: eligible[0]?.date.toISOString().slice(0, 10) ?? null,
      lastDate: eligible.at(-1)?.date.toISOString().slice(0, 10) ?? null,
    };
  }
}
