import { initialSchemaMigration } from "./001-initial-schema.js";
import { tradeIdeaProposalIdentityMigration } from "./002-trade-idea-proposal-identity.js";
import { modelPredictionIdentityMigration } from "./003-model-prediction-identity.js";
import { marketNewsSchemaMigration } from "./004-market-news-schema.js";
import { aiMemoryAndRagMigration } from "./005-ai-memory-and-rag.js";
import { addRegimeEvidenceMigration } from "./006-add-regime-evidence.js";
import { institutionalFlowsAndOffshoreMigration } from "./007-institutional-flows-and-offshore.js";
import { addNewsProvidersMigration } from "./008-add-news-providers.js";
import { pendingPaperTradesMigration } from "./009-pending-paper-trades.js";
import { institutionalFlowAsOfMigration } from "./010-institutional-flow-as-of.js";
import { auxiliaryModelPredictionsMigration } from "./011-auxiliary-model-predictions.js";
import { removePseudoEmbeddingsMigration } from "./012-remove-pseudo-embeddings.js";
import { purgeFabricatedRsiMigration } from "./013-purge-fabricated-rsi.js";
import { correctSeedCandleProvenanceMigration } from "./014-correct-seed-candle-provenance.js";
import { tradeReviewsMigration } from "./015-trade-reviews.js";
import { scheduledJobRunsMigration } from "./016-scheduled-job-runs.js";

export const migrations = [
  initialSchemaMigration,
  tradeIdeaProposalIdentityMigration,
  modelPredictionIdentityMigration,
  marketNewsSchemaMigration,
  aiMemoryAndRagMigration,
  addRegimeEvidenceMigration,
  institutionalFlowsAndOffshoreMigration,
  addNewsProvidersMigration,
  pendingPaperTradesMigration,
  institutionalFlowAsOfMigration,
  auxiliaryModelPredictionsMigration,
  removePseudoEmbeddingsMigration,
  purgeFabricatedRsiMigration,
  correctSeedCandleProvenanceMigration,
  tradeReviewsMigration,
  scheduledJobRunsMigration,
];

