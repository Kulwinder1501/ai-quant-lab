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
});
