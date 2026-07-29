import type { NseApiClient } from "../../../infrastructure/external/nse-api-client.js";
import type { PostgresInstitutionalFlowRepository } from "../../../infrastructure/database/repositories/postgres-institutional-flow-repository.js";
import type { PostgresOffshoreDerivativeRepository } from "../../../infrastructure/database/repositories/postgres-offshore-derivative-repository.js";

export class CollectInstitutionalDataService {
  constructor(
    private readonly nseApiClient: NseApiClient,
    private readonly institutionalFlowRepo: PostgresInstitutionalFlowRepository,
    private readonly offshoreDerivativeRepo: PostgresOffshoreDerivativeRepository,
  ) {}

  async execute(): Promise<void> {
    const today = new Date();
    // Normalize to start of day
    today.setUTCHours(0, 0, 0, 0);

    try {
      console.log(`Fetching FII/DII data for ${today.toISOString().split("T")[0]}...`);
      const flow = await this.nseApiClient.getFiiDiiData(today);
      if (flow) {
        await this.institutionalFlowRepo.upsert(flow);
        console.log(`Successfully stored FII/DII data: FII=${flow.fiiCashNetCr}Cr, DII=${flow.diiCashNetCr}Cr`);
      } else {
        console.warn("No FII/DII data returned from NSE API.");
      }

      console.log(`Fetching GIFT Nifty data for ${today.toISOString().split("T")[0]}...`);
      const giftNifty = await this.nseApiClient.getGiftNiftyData(today);
      if (giftNifty) {
        await this.offshoreDerivativeRepo.upsert(giftNifty);
        console.log(`Successfully stored GIFT Nifty data.`);
      }
    } catch (error) {
      console.error("Failed to collect institutional data:", error);
    }
  }
}
