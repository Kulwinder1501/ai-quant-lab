import type { NewsRepository } from "../domain/news-article.js";

const MACRO_KEYWORDS = [
  "rbi",
  "policy",
  "budget",
  "election",
  "cpi",
  "fed",
  "inflation",
  "rate cut",
  "nfp",
  "repo rate",
  "powell",
  "das"
];

const IST = "Asia/Kolkata";

export interface ScheduledMacroEvent {
  eventDate: string;
  name: string;
  region: string;
  source: string;
  sourceUrl: string | null;
  verified: true;
}

export interface MacroEventsResult {
  /**
   * Dated calendar rows for today/tomorrow IST — the only signal that may hard-gate entries.
   * Kept as `hasMacroEvent` so validators and older callers treat scheduled risk correctly.
   */
  hasMacroEvent: boolean;
  /** Scheduled event names (same set as `scheduledEvents`). */
  events: string[];
  hasScheduledEvent: boolean;
  scheduledEvents: ScheduledMacroEvent[];
  /** Verified calendar rows over the next 120 IST calendar days, for display only. */
  upcomingScheduledEvents: ScheduledMacroEvent[];
  /** Keyword headline heat — soft context only; never a hard block. */
  hasHeadlineHeat: boolean;
  headlineEvents: string[];
}

interface QueryableDatabase {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
}

function istDateKey(instant: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: IST }).format(instant);
}

function addIstDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const utc = new Date(Date.UTC(y!, m! - 1, d! + days));
  return utc.toISOString().slice(0, 10);
}

/**
 * Scheduled calendar for hard gates + keyword headline heat for soft caution.
 *
 * Keyword matches fire on most days of financial newswire coverage; wiring them into
 * `validateOptionsEntry` would refuse almost every entry. Only dated `scheduled_macro_events`
 * rows may assert `hasMacroEvent`.
 */
export class CheckMacroEventsService {
  public constructor(
    private readonly repository: NewsRepository,
    private readonly database?: QueryableDatabase,
  ) {}

  public async execute(now = new Date()): Promise<MacroEventsResult> {
    const todayIst = istDateKey(now);
    const tomorrowIst = addIstDays(todayIst, 1);
    const horizonIst = addIstDays(todayIst, 120);

    const [scheduledEvents, upcomingScheduledEvents, headlineEvents] = await Promise.all([
      this.loadScheduledEvents(todayIst, tomorrowIst),
      this.loadScheduledEvents(todayIst, horizonIst),
      this.loadHeadlineHeat(),
    ]);

    return {
      hasMacroEvent: scheduledEvents.length > 0,
      events: scheduledEvents.map((event) => event.name),
      hasScheduledEvent: scheduledEvents.length > 0,
      scheduledEvents,
      upcomingScheduledEvents,
      hasHeadlineHeat: headlineEvents.length > 0,
      headlineEvents,
    };
  }

  private async loadScheduledEvents(todayIst: string, tomorrowIst: string): Promise<ScheduledMacroEvent[]> {
    if (!this.database) return [];
    try {
      const result = await this.database.query<{
        event_date: string | Date;
        name: string;
        region: string;
        source: string;
        source_url: string | null;
        verified: boolean;
      }>(`
        SELECT event_date, name, region, source, source_url, verified
        FROM scheduled_macro_events
        WHERE event_date BETWEEN $1::date AND $2::date
          AND verified = TRUE
        ORDER BY event_date ASC, name ASC
      `, [todayIst, tomorrowIst]);

      return result.rows.map((row) => ({
        eventDate: typeof row.event_date === "string"
          ? row.event_date.slice(0, 10)
          : row.event_date.toISOString().slice(0, 10),
        name: row.name,
        region: row.region,
        source: row.source,
        sourceUrl: row.source_url,
        verified: true,
      }));
    } catch (error) {
      console.warn("scheduled_macro_events lookup failed:", error);
      return [];
    }
  }

  private async loadHeadlineHeat(): Promise<string[]> {
    const recentArticles = await this.repository.findRecent({ limit: 100 });
    const macroEvents = new Set<string>();

    for (const article of recentArticles) {
      const text = `${article.title} ${article.description}`.toLowerCase();
      for (const keyword of MACRO_KEYWORDS) {
        if (text.includes(keyword)) {
          macroEvents.add(article.title);
        }
      }
    }

    return Array.from(macroEvents);
  }
}
