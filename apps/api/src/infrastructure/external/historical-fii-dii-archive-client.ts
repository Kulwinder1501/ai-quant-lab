import axios from "axios";
import type { InstitutionalFlow } from "../../modules/market-data/domain/institutional-flow.js";

const DEFAULT_ARCHIVE_URL =
  "https://raw.githubusercontent.com/MrChartist/fii-dii-data/main/data/history.json";
const TRUSTED_PIPELINES = new Set(["fetch-pipeline", "live-fetch"]);
const MAX_ABSOLUTE_FLOW_CR = 1_000_000;

interface ArchiveRow {
  date?: unknown;
  fii_buy?: unknown;
  fii_sell?: unknown;
  fii_net?: unknown;
  dii_buy?: unknown;
  dii_sell?: unknown;
  dii_net?: unknown;
  _source?: unknown;
}

function number(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDate(value: unknown): Date | null {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(String(value).trim());
  if (!match) return null;
  const month = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"]
    .indexOf(match[2].toUpperCase());
  if (month < 0) return null;
  const parsed = new Date(Date.UTC(Number(match[3]), month, Number(match[1])));
  return parsed.getUTCDate() === Number(match[1]) ? parsed : null;
}

function readNet(row: ArchiveRow, netKey: "fii_net" | "dii_net", buyKey: "fii_buy" | "dii_buy", sellKey: "fii_sell" | "dii_sell"): number | null {
  const net = number(row[netKey]);
  const buy = number(row[buyKey]);
  const sell = number(row[sellKey]);
  if (net === null || buy === null || sell === null) return null;
  if (Math.abs(net) > MAX_ABSOLUTE_FLOW_CR || Math.abs((buy - sell) - net) > 0.11) return null;
  return Number(net.toFixed(4));
}

/**
 * Historical bridge for NSE cash-flow prints.
 *
 * NSE's public endpoint exposes only the latest session. This archive stores its
 * daily pulls, but also contains rows explicitly tagged as historical seeds. We
 * accept only rows tagged as a real fetch pipeline and reject every seeded row.
 */
export class HistoricalFiiDiiArchiveClient {
  private readonly url: string;

  constructor(url = process.env.FII_DII_HISTORY_URL) {
    this.url = url?.trim() || DEFAULT_ARCHIVE_URL;
  }

  async fetch(): Promise<InstitutionalFlow[]> {
    const response = await axios.get(this.url, { timeout: 20_000, responseType: "json" });
    if (!Array.isArray(response.data)) throw new Error("Historical FII/DII archive did not return an array.");

    const flows: InstitutionalFlow[] = [];
    for (const candidate of response.data as ArchiveRow[]) {
      const upstreamSource = String(candidate?._source ?? "");
      if (!TRUSTED_PIPELINES.has(upstreamSource)) continue;
      const date = parseDate(candidate.date);
      const fiiCashNetCr = readNet(candidate, "fii_net", "fii_buy", "fii_sell");
      const diiCashNetCr = readNet(candidate, "dii_net", "dii_buy", "dii_sell");
      if (!date || fiiCashNetCr === null || diiCashNetCr === null) continue;

      flows.push({
        date,
        fiiCashNetCr,
        diiCashNetCr,
        fiiIndexFuturesNetCr: null,
        fiiIndexOptionsNetCr: null,
        // Conservative point-in-time contract: the same 18:30 IST publication
        // assumption used by migration 010, never the archive download time.
        publishedAt: new Date(date.getTime() + 13 * 60 * 60 * 1000),
        source: `MRCHARTIST_NSE_ARCHIVE:${upstreamSource}`,
        isProvisional: true,
      });
    }

    if (flows.length === 0) throw new Error("Historical FII/DII archive contained no trusted, valid rows.");
    return flows.sort((a, b) => a.date.getTime() - b.date.getTime());
  }
}
