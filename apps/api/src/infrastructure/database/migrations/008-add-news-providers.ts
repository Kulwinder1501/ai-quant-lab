import type { Migration } from "../migration-runner.js";

export const addNewsProvidersMigration: Migration = {
  id: "008-add-news-providers",
  sql: `
    ALTER TABLE market_news DROP CONSTRAINT IF EXISTS market_news_provider_check;
    ALTER TABLE market_news ADD CONSTRAINT market_news_provider_check CHECK (provider IN ('MONEYCONTROL', 'ECONOMIC_TIMES', 'LIVEMINT', 'NSE', 'TIMES_OF_INDIA', 'BUSINESS_STANDARD', 'NDTV_PROFIT'));
  `,
};
