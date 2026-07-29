import { initialSchemaMigration } from "./001-initial-schema.js";
import { tradeIdeaProposalIdentityMigration } from "./002-trade-idea-proposal-identity.js";
import { modelPredictionIdentityMigration } from "./003-model-prediction-identity.js";
import { marketNewsSchemaMigration } from "./004-market-news-schema.js";
import { aiMemoryAndRagMigration } from "./005-ai-memory-and-rag.js";
import { addRegimeEvidenceMigration } from "./006-add-regime-evidence.js";

export const migrations = [
  initialSchemaMigration,
  tradeIdeaProposalIdentityMigration,
  modelPredictionIdentityMigration,
  marketNewsSchemaMigration,
  aiMemoryAndRagMigration,
  addRegimeEvidenceMigration,
];
