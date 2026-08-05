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

export interface MacroEventsResult {
  hasMacroEvent: boolean;
  events: string[];
}

export class CheckMacroEventsService {
  public constructor(private readonly repository: NewsRepository) {}

  public async execute(): Promise<MacroEventsResult> {
    const filter = { limit: 100 };
    // Find all recent articles (last 24h depending on repository implementation)
    const recentArticles = await this.repository.findRecent(filter);

    const macroEvents = new Set<string>();

    for (const article of recentArticles) {
      const text = `${article.title} ${article.description}`.toLowerCase();
      
      for (const keyword of MACRO_KEYWORDS) {
        if (text.includes(keyword)) {
          macroEvents.add(article.title);
        }
      }
    }

    const events = Array.from(macroEvents);

    return {
      hasMacroEvent: events.length > 0,
      events,
    };
  }
}
