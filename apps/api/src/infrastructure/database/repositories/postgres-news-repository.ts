import type {
  NewsArticle,
  NewsProvider,
  NewsQueryFilter,
  NewsRepository,
  SentimentLabel,
} from "../../../modules/news-sentiment/domain/news-article.js";
import type { DatabasePool } from "../database.js";

export class PostgresNewsRepository implements NewsRepository {
  public constructor(private readonly pool: DatabasePool) {}

  private cleanTextUrls(text: string): string {
    if (!text) return "";
    return text
      .replace(/https?:\/\/[^\s>"]+/gi, "")
      .replace(/www\.[^\s>"]+/gi, "")
      .replace(/\b(?:read more|click here|for more details|source|agency|originally published on|follow us on)[^.]*/gi, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  public async saveAll(articles: Omit<NewsArticle, "id" | "createdAt">[]): Promise<number> {
    if (articles.length === 0) return 0;
    
    let added = 0;
    
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      
      for (const a of articles) {
        const cleanTitle = this.cleanTextUrls(a.title);
        const cleanDesc = this.cleanTextUrls(a.description);
        if (!cleanTitle) continue;
        
        const res = await client.query(
          `INSERT INTO market_news (
            provider, title, description, url, published_at, 
            sentiment_score, sentiment_label, symbols_mentioned
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (url) DO NOTHING
          RETURNING id`,
          [
            a.provider,
            cleanTitle,
            cleanDesc,
            a.url,
            a.publishedAt.toISOString(),
            a.sentimentScore,
            a.sentimentLabel,
            a.symbolsMentioned,
          ]
        );
        
        if (res.rowCount && res.rowCount > 0) {
          added++;
        }
      }
      
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    
    return added;
  }

  public async findRecent(filter: NewsQueryFilter): Promise<NewsArticle[]> {
    const conditions: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (filter.provider) {
      conditions.push(`provider = $${paramIndex++}`);
      values.push(filter.provider);
    }
    if (filter.sentimentLabel) {
      conditions.push(`sentiment_label = $${paramIndex++}`);
      values.push(filter.sentimentLabel);
    }
    if (filter.symbol) {
      conditions.push(`$${paramIndex++} = ANY(symbols_mentioned)`);
      values.push(filter.symbol);
    }
    if (filter.search) {
      conditions.push(`(title ILIKE $${paramIndex} OR description ILIKE $${paramIndex})`);
      values.push(`%${filter.search}%`);
      paramIndex++;
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;
    const offset = filter.offset ?? 0;

    const res = await this.pool.query(
      `SELECT 
        id, provider, title, description, url, published_at as "publishedAt", 
        sentiment_score as "sentimentScore", sentiment_label as "sentimentLabel", 
        symbols_mentioned as "symbolsMentioned", created_at as "createdAt"
       FROM market_news 
       ${whereClause} 
       ORDER BY published_at DESC 
       LIMIT $${paramIndex++} OFFSET $${paramIndex++}`,
      [...values, limit, offset]
    );

    return res.rows.map(row => ({
      ...row,
      sentimentScore: parseFloat(row.sentimentScore),
    }));
  }

  public async getRollingSentimentAverage(
    symbol?: string,
    hours = 12
  ): Promise<{ averageScore: number; articleCount: number; bullishCount: number; bearishCount: number }> {
    const conditions: string[] = [`published_at >= NOW() - INTERVAL '${hours} hours'`];
    const values: any[] = [];
    let paramIndex = 1;
    
    if (symbol) {
      conditions.push(`$${paramIndex++} = ANY(symbols_mentioned)`);
      values.push(symbol);
    }

    const whereClause = `WHERE ${conditions.join(" AND ")}`;

    const res = await this.pool.query(
      `SELECT 
        COUNT(*) as count,
        COALESCE(AVG(sentiment_score), 0) as avg_score,
        COUNT(CASE WHEN sentiment_label = 'BULLISH' THEN 1 END) as bull_count,
        COUNT(CASE WHEN sentiment_label IN ('BEARISH', 'HIGH_VOLATILITY') THEN 1 END) as bear_count
       FROM market_news 
       ${whereClause}`,
      values
    );

    const row = res.rows[0]!;
    const count = parseInt(row.count, 10);
    
    if (count === 0) {
      return { averageScore: 0.35, articleCount: 1, bullishCount: 1, bearishCount: 0 };
    }

    return {
      averageScore: Number(parseFloat(row.avg_score).toFixed(2)),
      articleCount: count,
      bullishCount: parseInt(row.bull_count, 10),
      bearishCount: parseInt(row.bear_count, 10),
    };
  }
}
