import type { NewsArticle, NewsProvider, NewsRepository, SentimentLabel } from "../domain/news-article.js";

interface RssFeedConfig {
  provider: NewsProvider;
  url: string;
}

const RSS_FEEDS: RssFeedConfig[] = [
  { provider: "LIVEMINT", url: "https://www.livemint.com/rss/markets" },
  { provider: "LIVEMINT", url: "https://www.livemint.com/rss/companies" },
  { provider: "TIMES_OF_INDIA", url: "https://timesofindia.indiatimes.com/rssfeeds/1898055.cms" },
  { provider: "BUSINESS_STANDARD", url: "https://www.business-standard.com/rss/markets-106.rss" },
  { provider: "NDTV_PROFIT", url: "https://feeds.feedburner.com/ndtvprofit-latest" },
];

const BULLISH_WORDS = [
  "profit", "jumps", "jump", "surge", "surges", "gain", "gains", "rally", "rallies",
  "growth", "dividend", "up", "bull", "bullish", "rebound", "rebounds", "higher",
  "record", "upgrade", "upgraded", "boost", "boosts", "strong", "robust", "beat",
  "beats", "positive", "expansion", "inflow", "inflows", "highs"
];

const BEARISH_WORDS = [
  "slump", "slumps", "fall", "falls", "plunge", "plunges", "decline", "declines",
  "loss", "losses", "down", "bear", "bearish", "war", "hostilities", "crunch",
  "default", "defaults", "selloff", "downgrade", "downgraded", "deficit", "penalty",
  "suspicious", "fraud", "probe", "investigation", "panic", "crash", "crashes",
  "halted", "tension", "tensions", "weaker", "weakness"
];

const HIGH_VOLATILITY_WORDS = [
  "crash", "panic", "war", "fraud", "halted", "default", "suspicious", "probe", "emergency"
];

const SYMBOL_MAPPINGS: Array<{ symbol: string; regex: RegExp }> = [
  { symbol: "NIFTY50", regex: /\b(nifty|nifty 50|sensex|index|equity markets)\b/i },
  { symbol: "BANKNIFTY", regex: /\b(bank nifty|banknifty|banking|rbi|hdfc|icici|sbi|canara bank|lender)\b/i },
  { symbol: "HDFCBANK", regex: /\b(hdfc bank|hdfc)\b/i },
  { symbol: "TATAPOWER", regex: /\b(tata power|tata)\b/i },
  { symbol: "RELIANCE", regex: /\b(reliance|ril|mukesh ambani)\b/i },
  { symbol: "INFY", regex: /\b(infosys|infy|tcs|it stocks|wipro)\b/i },
  { symbol: "COALINDIA", regex: /\b(coal india|psu)\b/i }
];

export class IngestRssNewsService {
  public constructor(private readonly repository: NewsRepository) {}

  public async execute(): Promise<{ ingestedCount: number; providerCounts: Record<string, number> }> {
    const allArticles: Omit<NewsArticle, "id" | "createdAt">[] = [];
    const providerCounts: Record<string, number> = {};

    for (const feed of RSS_FEEDS) {
      try {
        const res = await fetch(feed.url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AIQuantLab/1.0",
            "Accept": "application/rss+xml, application/xml, text/xml"
          },
          signal: AbortSignal.timeout(10000)
        });
        if (!res.ok) continue;

        const xmlText = await res.text();
        const articles = this.parseXml(xmlText, feed.provider);
        allArticles.push(...articles);
        providerCounts[feed.provider] = articles.length;
      } catch {
        // Network timeout or feed unreachable, continue to next provider
      }
    }

    const savedCount = await this.repository.saveAll(allArticles);
    return { ingestedCount: savedCount, providerCounts };
  }

  private parseXml(xml: string, provider: NewsProvider): Omit<NewsArticle, "id" | "createdAt">[] {
    const articles: Omit<NewsArticle, "id" | "createdAt">[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null) {
      const itemContent = match[1] ?? "";
      const title = this.extractTag(itemContent, "title");
      const link = this.extractTag(itemContent, "link") || this.extractTag(itemContent, "guid");
      let description = this.extractTag(itemContent, "description");
      const pubDateStr = this.extractTag(itemContent, "pubDate");

      if (!title || !link) continue;

      // Clean HTML tags and entities from description and title
      description = this.cleanText(description);
      const cleanTitle = this.cleanText(title);

      const publishedAt = pubDateStr ? new Date(pubDateStr) : new Date();
      if (isNaN(publishedAt.getTime())) continue;

      const { sentimentScore, sentimentLabel } = this.analyzeSentiment(cleanTitle, description);
      const symbolsMentioned = this.detectSymbols(cleanTitle, description);

      articles.push({
        provider,
        title: cleanTitle,
        description,
        url: link.trim(),
        publishedAt,
        sentimentScore,
        sentimentLabel,
        symbolsMentioned
      });
    }

    return articles;
  }

  private extractTag(xml: string, tag: string): string {
    const regex = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, "i");
    const match = regex.exec(xml);
    return match ? match[1]?.trim() ?? "" : "";
  }

  private cleanText(text: string): string {
    return text
      .replace(/<[^>]*>/g, "")
      .replace(/&lt;[^&]*&gt;/g, "")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private analyzeSentiment(title: string, description: string): { sentimentScore: number; sentimentLabel: SentimentLabel } {
    const text = `${title} ${description}`.toLowerCase();
    const words = text.match(/\b[a-z]{3,}\b/g) ?? [];

    let bullHits = 0;
    let bearHits = 0;
    let hasHighVolWord = false;

    for (const w of words) {
      if (BULLISH_WORDS.includes(w)) bullHits += 1.0;
      if (BEARISH_WORDS.includes(w)) bearHits += 1.5; // Weight bearish/crash terms higher
      if (HIGH_VOLATILITY_WORDS.includes(w)) hasHighVolWord = true;
    }

    const totalHits = bullHits + bearHits;
    let score = 0;
    if (totalHits > 0) {
      score = (bullHits - bearHits) / Math.max(totalHits, 3);
      score = Math.max(-1.0, Math.min(1.0, score));
    }

    let label: SentimentLabel = "NEUTRAL";
    if (hasHighVolWord || score <= -0.5) {
      label = score <= -0.5 ? "HIGH_VOLATILITY" : "BEARISH";
    } else if (score >= 0.2) {
      label = "BULLISH";
    } else if (score <= -0.2) {
      label = "BEARISH";
    }

    return { sentimentScore: Number(score.toFixed(4)), sentimentLabel: label };
  }

  private detectSymbols(title: string, description: string): string[] {
    const text = `${title} ${description}`;
    const symbols = new Set<string>();

    for (const mapping of SYMBOL_MAPPINGS) {
      if (mapping.regex.test(text)) {
        symbols.add(mapping.symbol);
      }
    }

    // Default to NIFTY50 if no specific stock mentioned for market-wide news
    if (symbols.size === 0) {
      symbols.add("NIFTY50");
    }

    return Array.from(symbols);
  }
}
