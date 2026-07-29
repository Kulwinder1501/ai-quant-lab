import type { NewsArticle, NewsQueryFilter, NewsRepository } from "../domain/news-article.js";

export class ListMarketNewsService {
  public constructor(private readonly repository: NewsRepository) {}

  public async execute(filter: NewsQueryFilter = {}): Promise<{
    articles: NewsArticle[];
    sentimentSummary: { averageScore: number; articleCount: number; bullishCount: number; bearishCount: number };
  }> {
    const [articles, sentimentSummary] = await Promise.all([
      this.repository.findRecent(filter),
      this.repository.getRollingSentimentAverage(filter.symbol, 24),
    ]);

    return {
      articles,
      sentimentSummary,
    };
  }
}
