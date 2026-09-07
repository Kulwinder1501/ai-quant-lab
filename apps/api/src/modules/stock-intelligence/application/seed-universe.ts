import type { InstrumentRepository } from "../../market-data/domain/instrument.js";
import { aliasKey } from "../domain/identity.js";
import { INDEX_CONTEXT_ROSTER, STOCK_INTELLIGENCE_ROSTER_AS_OF, stockIntelligenceEquityRoster, type SeedRosterName } from "../domain/seed-roster.js";
import type { StockIntelligenceStore } from "../domain/store.js";

export interface SeedStockIntelligenceUniverseResult {
  readonly rosterAsOf: string;
  readonly instrumentsCreated: number;
  readonly instrumentsReused: number;
  readonly membershipsWritten: number;
  readonly aliasesWritten: number;
  readonly survivorshipLimitation: string;
}

const SURVIVORSHIP_LIMITATION =
  `Roster frozen at ${STOCK_INTELLIGENCE_ROSTER_AS_OF} as a current-constituent snapshot. `
  + "It is not a reconstructed Nifty 50 / Next 50 membership archive. Historical replay dates "
  + "before that instant are ineligible until listing dates and historical index memberships "
  + "are sourced. listed_from is stored as unknown so existence cannot be assumed.";

export class SeedStockIntelligenceUniverse {
  constructor(
    private readonly instruments: InstrumentRepository,
    private readonly store: StockIntelligenceStore,
  ) {}

  async execute(): Promise<SeedStockIntelligenceUniverseResult> {
    const asOf = new Date(`${STOCK_INTELLIGENCE_ROSTER_AS_OF}T00:00:00.000Z`);
    let instrumentsCreated = 0;
    let instrumentsReused = 0;
    let membershipsWritten = 0;
    let aliasesWritten = 0;

    const rows: SeedRosterName[] = [...stockIntelligenceEquityRoster(), ...INDEX_CONTEXT_ROSTER];
    for (const row of rows) {
      const existing = await this.instruments.findByExchangeAndSymbol("NSE", row.symbol);
      const instrument = existing ?? await this.instruments.upsert({
        exchange: "NSE",
        symbol: row.symbol,
        displayName: row.displayName,
        instrumentType: row.universe === "INDEX_CONTEXT" ? "INDEX" : "EQUITY",
        isActive: false,
        metadata: {
          purpose: "stock-intelligence-universe",
          rosterAsOf: STOCK_INTELLIGENCE_ROSTER_AS_OF,
          survivorship: "current_roster_snapshot",
        },
      });
      if (existing) instrumentsReused += 1;
      else instrumentsCreated += 1;

      const memberships = await this.store.listMemberships(instrument.id);
      const hasMembership = memberships.some((membership) =>
        membership.universe === row.universe && membership.effectiveFrom.getTime() === asOf.getTime()
      );
      if (!hasMembership) {
        await this.store.upsertMembership({
          instrumentId: instrument.id,
          universe: row.universe,
          effectiveFrom: asOf,
          effectiveTo: null,
          availableAt: asOf,
          provenance: "current_roster_snapshot",
        });
        membershipsWritten += 1;
      }

      const existence = await this.store.findExistenceAsOf(instrument.id, asOf);
      if (!existence) {
        await this.store.upsertExistence({
          instrumentId: instrument.id,
          listedFrom: null,
          listedTo: null,
          availableAt: asOf,
        });
      }

      for (const alias of row.aliases) {
        const key = aliasKey(alias);
        const mapped = await this.store.findAlias(key);
        if (mapped === instrument.id) continue;
        if (mapped && mapped !== instrument.id) {
          throw new Error(`Alias "${key}" already maps to ${mapped}, not ${instrument.id}.`);
        }
        await this.store.upsertAlias({ alias: key, instrumentId: instrument.id });
        aliasesWritten += 1;
      }
    }

    return {
      rosterAsOf: STOCK_INTELLIGENCE_ROSTER_AS_OF,
      instrumentsCreated,
      instrumentsReused,
      membershipsWritten,
      aliasesWritten,
      survivorshipLimitation: SURVIVORSHIP_LIMITATION,
    };
  }
}
