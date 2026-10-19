import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN_PATTERNS = [
  /paper-trading/i,
  /strategy-engine/i,
  /risk-management/i,
  /order-execution/i,
  /order-placement/i,
  /fyers/i,
];

function getAllTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...getAllTsFiles(fullPath));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }

  return files;
}

export function findForbiddenImports(source: string): string[] {
  const importLines = [
    ...source.matchAll(/from\s+["']([^"']+)["']/g),
    ...source.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...source.matchAll(/require\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1]);

  const violations: string[] = [];
  for (const imp of importLines) {
    for (const forbidden of FORBIDDEN_PATTERNS) {
      if (forbidden.test(imp)) {
        violations.push(`${imp} (matches ${forbidden.toString()})`);
      }
    }
  }

  return violations;
}

export function findForeignSchemaQueries(source: string): string[] {
  const matches = [
    ...source.matchAll(/(?:FROM|JOIN|INTO|UPDATE)\s+([a-zA-Z0-9_]+)\.([a-zA-Z0-9_]+)/gi),
  ];
  const violations: string[] = [];
  for (const match of matches) {
    const schema = match[1].toLowerCase();
    if (schema !== "equity_research" && !schema.startsWith("pg_")) {
      violations.push(`${match[0]} (schema '${schema}' is forbidden in equity-research)`);
    }
  }
  return violations;
}

describe("Equity Research isolation and no-coupling boundary (G1, S10, Gate E13)", () => {
  it("never imports from trading, strategy, risk, orders, or fyers", () => {
    const files = getAllTsFiles(MODULE_DIR);
    const violations: { file: string; violations: string[] }[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const found = findForbiddenImports(content);
      if (found.length > 0) {
        violations.push({ file: file.slice(MODULE_DIR.length + 1), violations: found });
      }
    }

    expect(
      violations,
      `Hard boundary violated! equity-research must remain completely decoupled: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("actively detects violations when a forbidden import is added", () => {
    const syntheticSourceWithPaperTrading = `import { PaperTradeService } from "../../paper-trading/domain/service.js";`;
    const syntheticSourceWithFyers = `import { fyersClient } from "../../platform/fyers/client.js";`;
    const cleanSource = `import { YahooClient } from "./infrastructure/yahoo-client.js";`;

    expect(findForbiddenImports(syntheticSourceWithPaperTrading).length).toBeGreaterThan(0);
    expect(findForbiddenImports(syntheticSourceWithFyers).length).toBeGreaterThan(0);
    expect(findForbiddenImports(cleanSource).length).toBe(0);
  });

  it("strictly queries only equity_research schema, never foreign schemas (Gate E13)", () => {
    const files = getAllTsFiles(MODULE_DIR);
    const violations: { file: string; violations: string[] }[] = [];

    for (const file of files) {
      const content = readFileSync(file, "utf8");
      const found = findForeignSchemaQueries(content);
      if (found.length > 0) {
        violations.push({ file: file.slice(MODULE_DIR.length + 1), violations: found });
      }
    }

    expect(
      violations,
      `Gate E13 violated! equity-research must never read or write tables outside equity_research schema: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  });

  it("actively detects foreign schema queries (Gate E13 test guard)", () => {
    const syntheticQueryWithPaperTrading = `SELECT * FROM paper_trading.trades WHERE id = $1;`;
    const syntheticQueryWithPublicCandles = `SELECT * FROM public.candles_1m WHERE symbol = 'NIFTY';`;
    const cleanQuery = `SELECT * FROM equity_research.alert WHERE stock_id = $1;`;

    expect(findForeignSchemaQueries(syntheticQueryWithPaperTrading).length).toBeGreaterThan(0);
    expect(findForeignSchemaQueries(syntheticQueryWithPublicCandles).length).toBeGreaterThan(0);
    expect(findForeignSchemaQueries(cleanQuery).length).toBe(0);
  });
});

