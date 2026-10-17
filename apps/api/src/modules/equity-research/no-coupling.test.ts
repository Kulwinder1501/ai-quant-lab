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

describe("Equity Research isolation and no-coupling boundary (G1, S10)", () => {
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
});
