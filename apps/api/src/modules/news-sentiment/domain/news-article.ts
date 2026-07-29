export type NewsProvider = "MONEYCONTROL" | "ECONOMIC_TIMES" | "LIVEMINT" | "NSE";
export type SentimentLabel = "BULLISH" | "BEARISH" | "NEUTRAL" | "HIGH_VOLATILITY";

export interface NewsArticle {
  id: string;
  provider: NewsProvider;
  title: string;
  description: string;
  url: string;
  publishedAt: Date;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
  symbolsMentioned: string[];
  createdAt: Date;
}

export interface NewsQueryFilter {
  provider?: NewsProvider;
  sentimentLabel?: SentimentLabel;
  symbol?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface NewsRepository {
  saveAll(articles: Omit<NewsArticle, "id" | "createdAt">[]): Promise<number>;
  findRecent(filter: NewsQueryFilter): Promise<NewsArticle[]>;
  getRollingSentimentAverage(symbol?: string, hours?: number): Promise<{ averageScore: number; articleCount: number; bullishCount: number; bearishCount: number }>;
}
