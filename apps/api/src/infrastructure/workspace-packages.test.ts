import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the packaging shape of every shared workspace package.
 *
 * `@ai-quant-lab/contracts` shipped for months with `main` pointing at `src/index.ts`. That
 * resolves perfectly under `tsc`, so nothing complained — and it would have failed at runtime
 * the first time the API imported a value from it, because `node dist/server.js` cannot
 * execute TypeScript. It survived only because the package is types-only and nothing imported
 * it, so the import was erased before it could fail.
 *
 * `@ai-quant-lab/pricing` was created with the same mistake and caught during its own
 * rollout. Asserted structurally rather than as a list of package names, so a package added
 * later is covered without anyone remembering this file exists.
 */
const PACKAGES_DIR = join(process.cwd(), "..", "..", "packages");

function workspacePackages(): Array<{ name: string; manifest: Record<string, unknown> }> {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(PACKAGES_DIR, entry.name, "package.json"))
    .filter((path) => existsSync(path))
    .map((path) => ({
      name: path,
      manifest: JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>,
    }));
}

describe("shared workspace packages", () => {
  const packages = workspacePackages();

  it("finds the packages to check, so a passing suite cannot mean an empty list", () => {
    expect(packages.length).toBeGreaterThan(0);
  });

  for (const { name, manifest } of packages) {
    const label = String(manifest.name ?? name);

    it(`${label} points main at emitted JavaScript, not TypeScript source`, () => {
      const main = String(manifest.main ?? "");
      expect(main, `${label} declares no main`).not.toBe("");
      // The specific failure: a .ts main resolves under tsc and dies under node.
      expect(main.endsWith(".ts")).toBe(false);
      expect(main.startsWith("dist/")).toBe(true);
    });

    it(`${label} declares a build that produces that output`, () => {
      const scripts = (manifest.scripts ?? {}) as Record<string, string>;
      // Without a build script the emitted output only exists on machines that happened to
      // create it, which is how a Docker image can build locally and fail on a clean checkout.
      expect(scripts.build, `${label} has no build script`).toBeTruthy();
    });

    it(`${label} ships types alongside, so consumers do not fall back to any`, () => {
      expect(String(manifest.types ?? "").endsWith(".d.ts")).toBe(true);
    });
  }
});
