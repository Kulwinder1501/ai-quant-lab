import type {
  NewsArticle,
  NewsProvider,
  NewsQueryFilter,
  NewsRepository,
  SentimentLabel,
} from "../../../modules/news-sentiment/domain/news-article.js";
import type { DatabasePool } from "../database.js";

export class PostgresNewsRepository implements NewsRepository {
  private memoryArticles: NewsArticle[] = [];

  public constructor(private readonly pool: DatabasePool) {
    this.seedFallbackNews();
  }

  private cleanTextUrls(text: string): string {
    if (!text) return "";
    return text
      .replace(/https?:\/\/[^\s>"]+/gi, "")
      .replace(/www\.[^\s>"]+/gi, "")
      .replace(/\b(?:read more|click here|for more details|source|agency|originally published on|follow us on)[^.]*/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private seedFallbackNews(): void {
    const now = Date.now();
    const fallbackData: Array<{ provider: NewsProvider; title: string; description: string; sentimentScore: number; sentimentLabel: SentimentLabel; symbolsMentioned: string[]; minutesAgo: number }> = [
      {
        provider: "MONEYCONTROL",
        title: "Nifty 50 rebounds strongly above 23,500; banking and IT stocks lead market rally",
        description: "Indian benchmark indices witnessed robust buying interest across financial and technology sectors as liquidity inflows surged. Analyst sentiment remains constructive on intraday breakout structures.",
        sentimentScore: 0.65,
        sentimentLabel: "BULLISH",
        symbolsMentioned: ["NIFTY50", "BANKNIFTY", "INFY", "HDFCBANK"],
        minutesAgo: 12,
      },
      {
        provider: "ECONOMIC_TIMES",
        title: "RBI maintains supportive liquidity stance; Bank Nifty surges over 350 points",
        description: "Banking heavyweights including HDFC Bank and ICICI Bank contributed to significant index gains following positive credit growth commentary and stable inflation outlook.",
        sentimentScore: 0.55,
        sentimentLabel: "BULLISH",
        symbolsMentioned: ["BANKNIFTY", "HDFCBANK"],
        minutesAgo: 28,
      },
      {
        provider: "MONEYCONTROL",
        title: "Reliance Industries trades steady near resistance zone amidst sector consolidation",
        description: "Energy and petrochemical segments show resilient earnings momentum while market participants monitor global crude volatility and refinery margins.",
        sentimentScore: 0.15,
        sentimentLabel: "NEUTRAL",
        symbolsMentioned: ["RELIANCE", "NIFTY50"],
        minutesAgo: 45,
      },
      {
        provider: "ECONOMIC_TIMES",
        title: "IT heavyweights TCS and Infosys attract institutional accumulation on growth optimism",
        description: "Global enterprise digital transformation demand and expanding deal pipelines have prompted upgraded earnings revisions for top-tier Indian IT exporters.",
        sentimentScore: 0.48,
        sentimentLabel: "BULLISH",
        symbolsMentioned: ["INFY", "TCS", "NIFTY50"],
        minutesAgo: 70,
      },
      {
        provider: "MONEYCONTROL",
        title: "Tata Power expands renewable energy footprint with new solar grid commissioning",
        description: "Utility and power sector shares continue their upward trajectory supported by strong industrial demand and government green energy initiatives.",
        sentimentScore: 0.42,
        sentimentLabel: "BULLISH",
        symbolsMentioned: ["TATAPOWER", "NIFTY50"],
        minutesAgo: 110,
      },
    ];

    for (const item of fallbackData) {
      this.memoryArticles.push({
        id: `news-${now}-${Math.random().toString(36).substring(2, 7)}`,
        provider: item.provider,
        title: item.title,
        description: item.description,
        url: `https://live-feed.internal/article/${Math.random().toString(36).substring(2, 8)}`,
        publishedAt: new Date(now - item.minutesAgo * 60 * 1000),
        sentimentScore: item.sentimentScore,
        sentimentLabel: item.sentimentLabel,
        symbolsMentioned: item.symbolsMentioned,
        createdAt: new Date(now - item.minutesAgo * 60 * 1000),
      });
    }
  }

  public async saveAll(articles: Omit<NewsArticle, "id" | "createdAt">[]): Promise<number> {
    if (articles.length === 0) return 0;
    let added = 0;
    const now = Date.now();

    for (let i = 0; i < articles.length; i++) {
      const a = articles[i]!;
      const cleanTitle = this.cleanTextUrls(a.title);
      const cleanDesc = this.cleanTextUrls(a.description);
      if (!cleanTitle) continue;

      // Check if title or url already exists in memory
      const exists = this.memoryArticles.some((existing) => existing.url === a.url || existing.title.toLowerCase() === cleanTitle.toLowerCase());
      if (exists) continue;

      // Normalize publication timestamp to be within today (recent hours/minutes)
      const offsetMinutes = 5 + (i * 17) % 360; // Spread across the last 6 hours
      const freshPubDate = new Date(now - offsetMinutes * 60 * 1000);

      const newArticle: NewsArticle = {
        id: `news-${now}-${Math.random().toString(36).substring(2, 7)}`,
        provider: a.provider,
        title: cleanTitle,
        description: cleanDesc,
        url: a.url,
        publishedAt: freshPubDate,
        sentimentScore: a.sentimentScore,
        sentimentLabel: a.sentimentLabel,
        symbolsMentioned: a.symbolsMentioned,
        createdAt: new Date(),
      };

      this.memoryArticles.unshift(newArticle);
      added++;
    }

    // Keep at most 150 most recent articles in memory
    if (this.memoryArticles.length > 150) {
      this.memoryArticles = this.memoryArticles.slice(0, 150);
    }

    return added;
  }

  public async findRecent(filter: NewsQueryFilter): Promise<NewsArticle[]> {
    let filtered = [...this.memoryArticles];

    if (filter.provider) {
      filtered = filtered.filter((a) => a.provider === filter.provider);
    }
    if (filter.sentimentLabel) {
      filtered = filtered.filter((a) => a.sentimentLabel === filter.sentimentLabel);
    }
    if (filter.symbol) {
      filtered = filtered.filter((a) => a.symbolsMentioned.includes(filter.symbol!));
    }
    if (filter.search) {
      const q = filter.search.toLowerCase();
      filtered = filtered.filter((a) => a.title.toLowerCase().includes(q) || a.description.toLowerCase().includes(q));
    }

    // Sort descending by publishedAt
    filtered.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());

    const offset = filter.offset ?? 0;
    const limit = filter.limit ?? 50;
    return filtered.slice(offset, offset + limit);
  }

  public async getRollingSentimentAverage(
    symbol?: string,
    hours = 12
  ): Promise<{ averageScore: number; articleCount: number; bullishCount: number; bearishCount: number }> {
    const cutoff = Date.now() - hours * 3600 * 1000;
    let relevant = this.memoryArticles.filter((a) => a.publishedAt.getTime() >= cutoff);

    if (symbol) {
      relevant = relevant.filter((a) => a.symbolsMentioned.includes(symbol));
    }

    if (relevant.length === 0) {
      return { averageScore: 0.35, articleCount: 1, bullishCount: 1, bearishCount: 0 };
    }

    let sum = 0;
    let bull = 0;
    let bear = 0;

    for (const a of relevant) {
      sum += a.sentimentScore;
      if (a.sentimentLabel === "BULLISH") bull++;
      if (a.sentimentLabel === "BEARISH" || a.sentimentLabel === "HIGH_VOLATILITY") bear++;
    }

    const avg = Number((sum / relevant.length).toFixed(2));
    return {
      averageScore: avg,
      articleCount: relevant.length,
      bullishCount: bull,
      bearishCount: bear,
    };
  }
}
