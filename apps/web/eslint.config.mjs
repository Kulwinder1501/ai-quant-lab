import { defineConfig, globalIgnores } from "eslint/config";
import nextTs from "eslint-config-next/typescript";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // An interface-required parameter a method must accept but deliberately ignores (e.g.
      // ISeriesPrimitiveBase.autoscaleInfo's startTimePoint/endTimePoint) is not dead code --
      // the leading underscore is the standard signal for "intentionally unused", not a typo.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);
