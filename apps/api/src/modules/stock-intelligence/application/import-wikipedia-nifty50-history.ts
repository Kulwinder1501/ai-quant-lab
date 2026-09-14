import type { InstrumentRepository } from "../../market-data/domain/instrument.js";
import { aliasKey } from "../domain/identity.js";
import {
  reconstructNifty50MembershipSpells,
  WIKIPEDIA_NIFTY50_SOURCE,
} from "../domain/wikipedia-nifty50-history.js";
import type { StockIntelligenceStore } from "../domain/store.js";

export interface ImportWikipediaNifty50HistoryResult {
  readonly source: typeof WIKIPEDIA_NIFTY50_SOURCE;
  readonly instrumentsCreated: number;
  readonly instrumentsReused: number;
  readonly membershipSpellsWritten: number;
  readonly existenceRowsWritten: number;
  readonly aliasesWritten: number;
  readonly distinctSymbols: number;
}

function aliasesFor(symbol: string, company: string): string[] {
  return [...new Set([
    symbol,
    symbol.replace(/-/g, ""),
    `${symbol}.NS`,
    company,
    company.toLowerCase(),
  ].map(aliasKey).filter(Boolean))];
}

/**
 * Imports the CC BY-SA Wikipedia reconstruction into the existing canonical
 * instrument and PIT universe tables. Membership is month-end precise.
 *
 * `listedFrom` is a conservative existence floor: being in NIFTY 50 proves
 * the security was listed by that month-end, but does not claim an exact IPO
 * date. This is sufficient for eligibility without inventing an earlier date.
 */
export class ImportWikipediaNifty50History {
  constructor(
    private readonly instruments: InstrumentRepository,
    private readonly store: StockIntelligenceStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<ImportWikipediaNifty50HistoryResult> {
    const spells = reconstructNifty50MembershipSpells();
    const firstBySymbol = new Map<string, (typeof spells)[number]>();
    for (const spell of spells) {
      const first = firstBySymbol.get(spell.symbol);
      if (!first || spell.effectiveFrom < first.effectiveFrom) {
        firstBySymbol.set(spell.symbol, spell);
      }
    }

    let instrumentsCreated = 0;
    let instrumentsReused = 0;
    let membershipSpellsWritten = 0;
    let existenceRowsWritten = 0;
    let aliasesWritten = 0;

    for (const [symbol, first] of firstBySymbol) {
      const existing = await this.instruments.findByExchangeAndSymbol("NSE", symbol);
      const instrument = existing ?? await this.instruments.upsert({
        exchange: "NSE",
        symbol,
        displayName: first.company,
        instrumentType: "EQUITY",
        isActive: false,
        metadata: {
          purpose: "stock-intelligence-historical-universe",
          source: WIKIPEDIA_NIFTY50_SOURCE.url,
          sourceLicense: WIKIPEDIA_NIFTY50_SOURCE.license,
          historyPrecision: "month_end",
        },
      });
      if (existing) instrumentsReused += 1;
      else instrumentsCreated += 1;

      const earliest = new Date(`${first.effectiveFrom}T23:59:59.999Z`);
      const historicalExistence = await this.store.findExistenceAsOf(instrument.id, earliest);
      if (!historicalExistence) {
        await this.store.upsertExistence({
          instrumentId: instrument.id,
          listedFrom: earliest,
          listedTo: null,
          availableAt: earliest,
        });
        existenceRowsWritten += 1;
      }

      // Replace the seed's current unknown existence with a later append-only
      // correction. The historical row remains available at its original PIT
      // cutoff; this row only changes what is known from import time onward.
      const importedAt = this.now();
      const currentExistence = await this.store.findExistenceAsOf(instrument.id, importedAt);
      if (!currentExistence || currentExistence.listedFrom === null) {
        await this.store.upsertExistence({
          instrumentId: instrument.id,
          listedFrom: earliest,
          listedTo: null,
          availableAt: importedAt,
        });
        existenceRowsWritten += 1;
      }

      const memberships = await this.store.listMemberships(instrument.id);
      for (const spell of spells.filter((row) => row.symbol === symbol)) {
        const effectiveFrom = new Date(`${spell.effectiveFrom}T23:59:59.999Z`);
        const effectiveTo = spell.effectiveTo
          ? new Date(`${spell.effectiveTo}T23:59:59.999Z`)
          : null;
        const alreadyStored = memberships.some((row) =>
          row.universe === "NIFTY50"
          && row.provenance === "historical_archive"
          && row.effectiveFrom.getTime() === effectiveFrom.getTime()
          && row.effectiveTo?.getTime() === effectiveTo?.getTime()
        );
        if (alreadyStored) continue;
        await this.store.upsertMembership({
          instrumentId: instrument.id,
          universe: "NIFTY50",
          effectiveFrom,
          effectiveTo,
          // An effective constituent list is public by the effective month-end.
          // Using the effective cutoff is conservative versus the earlier notice.
          availableAt: effectiveFrom,
          provenance: "historical_archive",
        });
        membershipSpellsWritten += 1;
      }

      for (const alias of aliasesFor(symbol, first.company)) {
        const mapped = await this.store.findAlias(alias);
        if (mapped === instrument.id) continue;
        if (mapped && mapped !== instrument.id) {
          throw new Error(`Historical alias "${alias}" already maps to ${mapped}, not ${instrument.id}.`);
        }
        await this.store.upsertAlias({ alias, instrumentId: instrument.id });
        aliasesWritten += 1;
      }
    }

    return {
      source: WIKIPEDIA_NIFTY50_SOURCE,
      instrumentsCreated,
      instrumentsReused,
      membershipSpellsWritten,
      existenceRowsWritten,
      aliasesWritten,
      distinctSymbols: firstBySymbol.size,
    };
  }
}
