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

  // =========================================================================
  // WP-B Step B3: Levels Engine Web UI Integration Checks
  // =========================================================================
  it("verifies EquityLevelsPanel includes mandatory empirical note (Section 5.3)", () => {
    const panelPath = resolve(__dirname, "./components/equity-levels-panel.tsx");
    const content = readFileSync(panelPath, "utf-8");

    // Exact empirical test disclosure text from plan Section 5.3
    expect(content).toContain(
      "Levels come from past prices and show where the market reacted before. In our test on 49 large Indian stocks, touches of such levels did not reliably predict the next 20 days, and breaks of resistance were followed by lower, not higher, returns.",
    );
  });

  it("verifies EquityLevelsPanel includes mandatory disclaimer footer (Section 5.3)", () => {
    const panelPath = resolve(__dirname, "./components/equity-levels-panel.tsx");
    const content = readFileSync(panelPath, "utf-8");

    // Exact disclaimer text
    expect(content).toContain(
      "Descriptive statistics of past prices on Yahoo's adjusted series. Price returns only (dividends excluded). Not a recommendation, rating or forecast.",
    );
  });

  it("verifies EquityLevelsPanel includes 'How these are calculated' disclosure and all 6 states", () => {
    const panelPath = resolve(__dirname, "./components/equity-levels-panel.tsx");
    const content = readFileSync(panelPath, "utf-8");

    // Disclosure accordion
    expect(content).toContain("How these are calculated");
    expect(content).toContain("Swing Pivot Clusters");
    expect(content).toContain("Zone Half-Width");
    expect(content).toContain("Side Classification");
    expect(content).toContain("Break & Flip Status");
    expect(content).toContain("Volume Profile");

    // All 6 states handled
    expect(content).toContain("Computing descriptive levels and reference points…"); // Loading
    expect(content).toContain("No price bar data available for"); // Empty
    expect(content).toContain("Unable to load price levels"); // Error
    expect(content).toContain("Price Data Stale"); // Stale
    expect(content).toContain("Calculations Suspended: Re-backfill Needed"); // Suspended
    expect(content).toContain("Reference Levels Only: History Under 258 Bars"); // Insufficient History
  });

  it("verifies EquityChart implements 6-line cap within 15%, neutral styling, and toggle (Gate L9)", () => {
    const chartPath = resolve(__dirname, "./components/equity-chart.tsx");
    const content = readFileSync(chartPath, "utf-8");

    // Cap to 6 lines within 15% of latest close
    expect(content).toContain("distPct <= 0.15");
    expect(content).toContain(".slice(0, 6)");

    // Neutral line styles (dashed for support, large-dashed for resistance, dotted for reference)
    expect(content).toContain("LineStyle.Dashed");
    expect(content).toContain("LineStyle.LargeDashed");
    expect(content).toContain("LineStyle.Dotted");

    // Neutral color palette strictly enforced (no green/red for levels)
    expect(content).toContain("rgba(56, 189, 248"); // Sky neutral for support
    expect(content).toContain("rgba(168, 85, 247"); // Violet neutral for resistance
    expect(content).toContain("rgba(148, 163, 184"); // Slate neutral for reference

    // Visibility toggle
    expect(content).toContain("Levels: {showLevels ? \"Shown\" : \"Hidden\"}");
    expect(content).toContain("aria-label=\"Toggle descriptive price levels\"");
  });

  it("verifies Detail Drawer integrates Levels tab and passes levels to EquityChart", () => {
    const drawerPath = resolve(__dirname, "./components/equity-stock-detail-drawer.tsx");
    const content = readFileSync(drawerPath, "utf-8");

    expect(content).toContain('onClick={() => setActiveTab("levels")}');
    expect(content).toContain("<EquityLevelsPanel");
    expect(content).toContain("levels={levels?.levels}");
  });
});

