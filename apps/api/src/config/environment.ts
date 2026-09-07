import { z } from "zod";

/**
 * Every environment variable this service reads, declared once.
 *
 * This used to validate three: NODE_ENV, API_PORT and DATABASE_URL. The other nine were read
 * ad hoc as `process.env.X` from about twenty files, which costs three things:
 *
 * - A typo is silent. `CORS_ORIGINS` misspelled in a compose file does not fail; the API just
 *   quietly falls back to its default origin list and the dashboard's requests are refused by
 *   a policy nobody configured.
 * - The default lives wherever it was first needed. `API_MUTATION_RATE_LIMIT` was parsed inside
 *   `createApp` with its own coercion and its own fallback, so the documented default in
 *   `.env.example` and the effective one could drift apart with nothing to compare.
 * - There is no list. Adding a variable to `.env.example` and forgetting it in
 *   `docker-compose.v2.yml` is invisible until the feature that needs it runs in a container --
 *   which is exactly how `FYERS_REDIRECT_URI` came to be absent from every service.
 *
 * Optional variables stay optional: this is a local-first research tool and most integrations
 * are opt-in. What they no longer do is invent their own parsing at the point of use.
 */
/**
 * The subset the HTTP layer needs, split out so `createApp` can be configured without a
 * `DATABASE_URL`.
 *
 * That separation is load-bearing rather than cosmetic: the route tests build an app around a
 * stub database and never set one, so a `createApp` that fell back to parsing the whole schema
 * would fail on a required variable it does not use. Both fields carry defaults, so this parses
 * successfully against an empty environment.
 */
const httpConfigurationSchema = z.object({
  /**
   * Browser origins allowed to call the API, as a comma-separated list.
   *
   * Parsed to an array here so `createApp` receives a validated value instead of splitting a
   * raw string itself. The default covers the dev server on 3000 and the v2 container on 3001.
   */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean))
    .refine((origins) => origins.length > 0, "CORS_ORIGINS must name at least one origin."),

  /** Per-IP state-changing requests accepted per minute. */
  API_MUTATION_RATE_LIMIT: z.coerce.number().int().positive().default(120),

  /**
   * Stock Intelligence HTTP surface. Default off until Gate 7. The dashboard tab
   * is gated by the matching NEXT_PUBLIC flag.
   */
  STOCK_INTELLIGENCE_API_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.trim().toLowerCase() === "true" || value.trim() === "1"),
});

export type HttpConfiguration = z.infer<typeof httpConfigurationSchema>;

export function loadHttpConfiguration(values: NodeJS.ProcessEnv = process.env): HttpConfiguration {
  return httpConfigurationSchema.parse(values);
}

const environmentSchema = httpConfigurationSchema.extend({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  /** Separate least-privilege role: SELECT operational data, write only research_scalp. */
  SCALP_RESEARCH_DATABASE_URL: z.string().url().optional(),

  /** Optional, read-only historical collection through Kite Connect v3. */
  KITE_API_KEY: z.string().optional(),
  KITE_ACCESS_TOKEN: z.string().optional(),

  /** Fyers API v3. All four are needed together; a partial set is a misconfiguration. */
  FYERS_APP_ID: z.string().optional(),
  FYERS_APP_SECRET: z.string().optional(),
  FYERS_REDIRECT_URI: z.string().optional(),
  FYERS_PIN: z.string().optional(),

  /** Optional comma-separated manual NSE market holidays (YYYY-MM-DD) for live polling. */
  NSE_HOLIDAYS: z.string().optional(),
  /** Optional paid/provider symbol. Left blank rather than substituting NIFTY spot. */
  GIFT_NIFTY_YAHOO_SYMBOL: z.string().optional(),
  /** Optional override for the provenance-filtered historical FII/DII archive. */
  FII_DII_HISTORY_URL: z.string().url().optional().or(z.literal("").transform(() => undefined)),

  /**
   * Stock Intelligence Gate 1 configuration. Defaults keep the subsystem off the HTTP
   * surface until Gate 7. Thresholds are parameters, not engine constants.
   */
  STOCK_INTELLIGENCE_STALE_DATA_6M_DAYS: z.coerce.number().int().positive().default(30),
  STOCK_INTELLIGENCE_STALE_DATA_12M_DAYS: z.coerce.number().int().positive().default(60),
  STOCK_INTELLIGENCE_FUNDAMENTAL_COMPLETENESS_MIN: z.coerce.number().min(0).max(1).default(0.7),
  STOCK_INTELLIGENCE_MIN_EFFECTIVE_ANALOGUES: z.coerce.number().int().positive().default(50),
});

export type Environment = z.infer<typeof environmentSchema>;

export function loadEnvironment(values: NodeJS.ProcessEnv = process.env): Environment {
  return environmentSchema.parse(values);
}

/**
 * True when the Fyers credential set is complete enough to authorize.
 *
 * `FYERS_APP_ID` and `FYERS_APP_SECRET` alone are enough to *refresh* an existing token, which
 * is why several call sites check only those two. Re-authorizing additionally needs the redirect
 * URI, and that distinction is worth naming rather than rediscovering per call site.
 */
export function hasFyersRefreshCredential(environment: Environment): boolean {
  return Boolean(environment.FYERS_APP_ID && environment.FYERS_APP_SECRET);
}

export function hasFyersAuthorizationCredential(environment: Environment): boolean {
  return hasFyersRefreshCredential(environment) && Boolean(environment.FYERS_REDIRECT_URI);
}
