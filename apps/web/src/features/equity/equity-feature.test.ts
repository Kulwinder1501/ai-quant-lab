import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { EquityApiError } from "./api";

describe("Equity Web Feature Integration & Gate S10 Coupling Checks", () => {
  it("verifies sidebar contains EQUITY navigation rail item (Gate S11)", () => {
    const sidebarPath = resolve(__dirname, "../../components/layout/sidebar.tsx");
    const content = readFileSync(sidebarPath, "utf-8");

    expect(content).toContain('title: "EQUITY"');
    expect(content).toContain('name: "Equity Watch"');
    expect(content).toContain('href: "/equity"');
    expect(content).toContain("LineChart");
  });

  it("verifies CommandPalette contains Equity Watch navigation", () => {
    const cmdPalettePath = resolve(__dirname, "../../components/ui/command-palette.tsx");
    const content = readFileSync(cmdPalettePath, "utf-8");

    expect(content).toContain("Equity Watch");
    expect(content).toContain("/equity");
  });

  it("verifies zero trading coupling in features/equity (Gate S10)", () => {
    const featureDir = resolve(__dirname);
    const forbiddenImports = [
      "paper-trading",
      "strategy-engine",
      "risk-management",
      "orders",
      "positions",
      "fyers",
      "kite",
    ];

    function scanFiles(dir: string): string[] {
      let results: string[] = [];
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results = results.concat(scanFiles(fullPath));
        } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const files = scanFiles(featureDir);
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf-8");
      for (const forbidden of forbiddenImports) {
        const hasImport =
          text.includes(`from "../${forbidden}`) ||
          text.includes(`from "../../${forbidden}`) ||
          text.includes(`from "../../../features/${forbidden}`);
        expect(hasImport).toBe(false);
      }
    }
  });

  it("verifies secondary fundamentals always carry mandatory heading and basis notice (Spec Requirement)", () => {
    const drawerPath = resolve(__dirname, "./components/equity-stock-detail-drawer.tsx");
    const content = readFileSync(drawerPath, "utf-8");

    // Exact heading specified in plan and checklist
    expect(content).toContain("Secondary, from Yahoo, not verified");
    // Exact basis notice
    expect(content).toContain("Basis (consolidated/standalone) is recorded as UNKNOWN because Yahoo does not report basis.");
  });

  it("verifies soft-delete disclosure exists in RemoveStockModal", () => {
    const modalPath = resolve(__dirname, "./components/remove-stock-modal.tsx");
    const content = readFileSync(modalPath, "utf-8");

    expect(content).toContain("historical daily bars and corporate actions will remain safely stored in the database");
  });

  it("verifies EquityApiError correctly captures HTTP status code and message", () => {
    const err = new EquityApiError("Not found", 404);
    expect(err.message).toBe("Not found");
    expect(err.status).toBe(404);
    expect(err.name).toBe("EquityApiError");
  });

  it("enforces Gate T5 wording rules across features/equity (no advice or verdict words)", () => {
    const featureDir = resolve(__dirname);
    const bannedWords = [
      "buy",
      "sell",
      "hold",
      "bullish",
      "bearish",
      "strong",
      "weak",
      "overbought",
      "oversold",
      "signal",
      "target",
      "outperform",
      "underperform",
      "recommend",
    ];

    function scanFiles(dir: string): string[] {
      let results: string[] = [];
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          results = results.concat(scanFiles(fullPath));
        } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
          results.push(fullPath);
        }
      }
      return results;
    }

    function extractUiStrings(text: string): string[] {
      const strings: string[] = [];
      // Double quoted strings
      const doubleQuotes = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
      let m;
      while ((m = doubleQuotes.exec(text)) !== null) {
        strings.push(m[1]);
      }
      // Single quoted strings
      const singleQuotes = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;
      while ((m = singleQuotes.exec(text)) !== null) {
        strings.push(m[1]);
      }
      // Backtick strings
      const backticks = /`([^`\\]*(?:\\.[^`\\]*)*)`/g;
      while ((m = backticks.exec(text)) !== null) {
        strings.push(m[1]);
      }
      // JSX text between > and <
      const jsxText = />([^<>{}\n\r]+)</g;
      while ((m = jsxText.exec(text)) !== null) {
        const trimmed = m[1].trim();
        if (trimmed) strings.push(trimmed);
      }
      return strings;
    }

    const files = scanFiles(featureDir);
    for (const file of files) {
      if (file.endsWith(".test.ts")) continue;
      const text = readFileSync(file, "utf-8");
      const uiStrings = extractUiStrings(text);

      for (const str of uiStrings) {
        // Skip technical API paths, CSS classes or empty strings
        if (str.startsWith("/") || str.startsWith("http")) continue;
        // Allow literal disclaimer phrase
        const cleanedStr = str.replace(/Not a recommendation, rating or forecast\./g, "");

        for (const word of bannedWords) {
          const regex = new RegExp(`\\b${word}\\b`, "i");
          const match = regex.exec(cleanedStr);
          expect(
            match,
            `Banned word '${word}' found in UI string in ${file}: "${str}"`,
          ).toBeNull();
        }
      }
    }
  });

  it("verifies Gate T6 disclaimer is present in EquityTrendPanel", () => {
    const panelPath = resolve(__dirname, "./components/equity-trend-panel.tsx");
    const content = readFileSync(panelPath, "utf-8");

    // Exact required text
    expect(content).toContain(
      "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.",
    );
  });

  it("verifies Detail Drawer places Trend tab first and supports phone width responsiveness", () => {
    const drawerPath = resolve(__dirname, "./components/equity-stock-detail-drawer.tsx");
    const content = readFileSync(drawerPath, "utf-8");

    expect(content).toContain('type TabType = "trend" | "chart"');
    expect(content).toContain('setActiveTab("trend")');
    // Gate T11: Mobile drawer padding and horizontal tab scrolling
    expect(content).toContain("pl-0 sm:pl-10");
    expect(content).toContain("overflow-x-auto no-scrollbar");
    expect(content).toContain("aria-label=\"Close detail view\"");
  });

  it("verifies Watchlist Table renders 1M, 1Y, and 52W Position with stale as-of date indicator", () => {
    const tablePath = resolve(__dirname, "./components/equity-watchlist-table.tsx");
    const content = readFileSync(tablePath, "utf-8");

    expect(content).toContain(">1M</th>");
    expect(content).toContain(">1Y</th>");
    expect(content).toContain(">52W Position</th>");
    expect(content).toContain("as of {stock.trendSummary.asOfDate}");
  });
});
