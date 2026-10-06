import "dotenv/config";
import fyersApi from "fyers-api-v3";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";

/**
 * One-shot diagnostic: what fields does the Fyers data socket actually send?
 *
 * Read-only and deliberately keys-only. It answers a single question that stored data cannot,
 * because `parseTick` narrows every payload to five fields at the socket boundary before anything
 * downstream sees it: does the live message carry an exchange clock, and is that clock *populated*?
 *
 * The distinction matters because the SDK's `HSM/mapper.js` already maps `fdtm -> exch_feed_time`
 * and `ltt -> last_traded_time` in the same `sfMapper` whose `bid_price` / `ask_price` /
 * `vol_traded_today` names `parseTick` reads — so the fields are almost certainly present. Presence
 * is not the question. The HTTP quotes endpoint also has a `tt` field, and measured against the live
 * endpoint it was the session date at UTC midnight for a mid-session equity: present, mapped, and
 * useless. Wiring that into execution eligibility would have placed every quote outside the session.
 *
 * So this reports, per field: the key, its type, whether it was null, and for timestamp-shaped
 * numbers a coarse classification of *what the value means* — session-time, midnight, epoch-zero or
 * implausible. No prices, sizes or quantities are printed; the timestamp classification is a derived
 * boolean about clock semantics, not market data.
 *
 * Costs one brief reconnect risk to the live collector if the provider limits concurrent data
 * sockets. Run it on a session that is already coverage-failed, never on one that might qualify.
 *
 * Usage: inspect-fyers-socket-payload [--messages 30] [--seconds 25]
 */

interface FieldObservation {
  types: Set<string>;
  nulls: number;
  present: number;
  timestampVerdicts: Set<string>;
}

/**
 * What a timestamp-shaped number actually denotes.
 *
 * `tt` on the quotes endpoint returned 1786060800 — exactly UTC midnight of the session date — for
 * an equity mid-session. That is the failure this classification is built to catch, so midnight is
 * called out as its own verdict rather than lumped in with "looks like a date".
 */
function classifyTimestamp(value: number, now: Date): string {
  if (!Number.isFinite(value) || value === 0) return "ZERO_OR_NON_FINITE";
  // Accept seconds or milliseconds; anything else is not a unix epoch.
  const asMs = value > 1e12 ? value : value * 1000;
  const when = new Date(asMs);
  if (Number.isNaN(when.getTime())) return "NOT_A_DATE";
  const ageMs = now.getTime() - asMs;
  if (Math.abs(ageMs) > 7 * 24 * 60 * 60 * 1000) return "MORE_THAN_A_WEEK_AWAY";
  const ist = new Date(asMs + 330 * 60_000);
  const secondOfDayIst = ist.getUTCHours() * 3600 + ist.getUTCMinutes() * 60 + ist.getUTCSeconds();
  if (secondOfDayIst === 0) return "IST_MIDNIGHT_DATE_ONLY";
  if (ist.getUTCHours() === 5 && ist.getUTCMinutes() === 30) return "UTC_MIDNIGHT_DATE_ONLY";
  const withinSession = secondOfDayIst >= 9 * 3600 + 15 * 60 && secondOfDayIst <= 15 * 3600 + 40 * 60;
  if (!withinSession) return "OUTSIDE_SESSION_HOURS";
  return Math.abs(ageMs) <= 5 * 60_000 ? "SESSION_TIME_AND_RECENT" : "SESSION_TIME_BUT_STALE";
}

const TIMESTAMP_KEYS = new Set([
  "exch_feed_time", "last_traded_time", "fdtm", "ltt", "timestamp", "tt", "tvalue",
]);

function option(args: readonly string[], name: string, fallback: number): number {
  const raw = args.find((argument) => argument.startsWith(`--${name}=`))?.split("=")[1];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer.`);
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const messageBudget = option(args, "messages", 30);
  const secondsBudget = option(args, "seconds", 25);

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  const appId = environment.FYERS_APP_ID;
  if (!appId) throw new Error("FYERS_APP_ID is required.");

  const appSecret = environment.FYERS_APP_SECRET;
  if (!appSecret) throw new Error("FYERS_APP_SECRET is required.");
  const tokenService = new FyersTokenService({
    pool: database,
    appId,
    appSecret,
    pin: process.env.FYERS_PIN ?? "",
  });

  const observations = new Map<string, FieldObservation>();
  let messages = 0;
  const now = (): Date => new Date();

  try {
    const accessToken = await tokenService.getAccessToken();
    const socket = fyersApi.fyersDataSocket.getInstance(`${appId}:${accessToken}`, "./fyers-logs", false) as {
      on: (event: string, handler: (payload: unknown) => void) => void;
      connect: () => void;
      subscribe: (symbols: string[]) => void;
      close?: () => void;
    };

    await new Promise<void>((resolveRun) => {
      const finish = (): void => resolveRun();
      const timer = setTimeout(finish, secondsBudget * 1000);

      socket.on("connect", () => {
        console.info("connected; subscribing");
        // An index and two option contracts already inside the live ATM band, so the sample covers
        // both payload shapes the mapper distinguishes (index feed vs symbol feed).
        socket.subscribe(["NSE:NIFTY50-INDEX", "NSE:NIFTY26AUG24200CE", "NSE:NIFTY26AUG24200PE"]);
      });

      socket.on("error", (error: unknown) => {
        console.error(`socket error: ${String(error)}`);
      });

      socket.on("message", (payload: unknown) => {
        if (typeof payload !== "object" || payload === null) return;
        messages += 1;
        for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
          const observation = observations.get(key) ?? {
            types: new Set<string>(), nulls: 0, present: 0, timestampVerdicts: new Set<string>(),
          };
          observation.present += 1;
          observation.types.add(value === null ? "null" : typeof value);
          if (value === null || value === undefined) observation.nulls += 1;
          if (TIMESTAMP_KEYS.has(key) && typeof value === "number") {
            observation.timestampVerdicts.add(classifyTimestamp(value, now()));
          }
          observations.set(key, observation);
        }
        if (messages >= messageBudget) {
          clearTimeout(timer);
          finish();
        }
      });

      socket.connect();
    });

    console.info(`\nmessages sampled: ${messages}`);
    console.info("field                     | type            | nulls | timestamp verdict");
    console.info("--------------------------|-----------------|-------|------------------------------");
    for (const [key, observation] of [...observations.entries()].sort()) {
      console.info(
        `${key.padEnd(25)} | ${[...observation.types].join(",").padEnd(15)} `
        + `| ${String(observation.nulls).padStart(5)} | ${[...observation.timestampVerdicts].join(",") || "-"}`,
      );
    }
    const hasExchangeClock = observations.has("exch_feed_time");
    const usable = observations.get("exch_feed_time")?.timestampVerdicts.has("SESSION_TIME_AND_RECENT") ?? false;
    console.info(
      `\nexch_feed_time present: ${hasExchangeClock}; carries a live session time: ${usable}`,
    );
    if (hasExchangeClock && !usable) {
      console.info(
        "Present but not a live session time -- this is the `tt` failure mode. Do NOT wire it into "
        + "execution eligibility on the strength of the field existing.",
      );
    }
  } finally {
    await database.end();
    // The SDK holds the process open on its own socket; nothing here writes, so exiting is safe.
    setTimeout(() => process.exit(0), 250);
  }
}

void main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
