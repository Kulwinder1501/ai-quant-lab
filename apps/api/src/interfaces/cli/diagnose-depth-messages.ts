import "dotenv/config";
import { createRequire } from "node:module";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { FyersTokenService } from "../../infrastructure/market-data/fyers-token-service.js";
import {
  FyersTbtDepthStreamer,
  type FyersTbtSocketLike,
} from "../../infrastructure/market-data/fyers-tbt-depth-streamer.js";
import { getOption } from "./arguments.js";

/**
 * Answers one question that cannot be answered offline: what is `MarketLevel.num`?
 *
 * ## Why this exists
 *
 * Captured depth frames are not coherent books -- 97.3% of stored BANKNIFTY futures frames carry a
 * spread a front-month future could not trade. The cause is in the vendor SDK
 * (`fyers-api-v3/tbtsocket/models.js`): the protobuf `MarketLevel` carries four fields -- `price`,
 * `qty`, `nord` and `num` -- but `_addDepth` writes each level at its *arrival index* `i` into a
 * persistent 50-slot array and never references `num` at all, with no clear and no removal path. A
 * sparse or partial update therefore lands a level in the wrong slot and leaves stale prices behind.
 *
 * If `num` is the level's position in the book, a correct collector is a small change: key the book
 * by `num` instead of `i`. If it is something else, that plan is wrong. Nothing stored answers this,
 * because we persisted the SDK's already-scrambled output rather than the raw messages, and the test
 * fixtures are synthetic and built at the `Depth` level. So this samples live messages and reports
 * the structure rather than assuming it.
 *
 * Read-only: it stores nothing, and calls the SDK's own `updateDepth` afterwards so the normal path
 * is unchanged. Run during market hours -- this feed answers a dead subscription with silence, so
 * zero messages means the contract is wrong, not that the book is quiet.
 *
 *   diagnose-depth-messages --symbols=NSE:BANKNIFTY26SEPFUT [--seconds=60]
 */

interface SideStats {
  messages: number;
  totalLevels: number;
  numPresent: number;
  numEqualsIndex: number;
  numEqualsIndexPlusOne: number;
  numOutsideBookRange: number;
  zeroQtyLevels: number;
  maxArrayLength: number;
  minArrayLength: number;
  numValues: Map<number, number>;
}

function emptySide(): SideStats {
  return {
    messages: 0,
    totalLevels: 0,
    numPresent: 0,
    numEqualsIndex: 0,
    numEqualsIndexPlusOne: 0,
    numOutsideBookRange: 0,
    zeroQtyLevels: 0,
    maxArrayLength: 0,
    minArrayLength: Number.MAX_SAFE_INTEGER,
    numValues: new Map<number, number>(),
  };
}

function unwrap(level: Record<string, unknown>, field: string): number | null {
  const wrapper = level[field] as { value?: unknown } | undefined;
  const value = wrapper?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(side: SideStats, levels: readonly Record<string, unknown>[]): void {
  side.messages += 1;
  side.maxArrayLength = Math.max(side.maxArrayLength, levels.length);
  side.minArrayLength = Math.min(side.minArrayLength, levels.length);
  levels.forEach((level, index) => {
    side.totalLevels += 1;
    if (unwrap(level, "qty") === 0) side.zeroQtyLevels += 1;
    const num = unwrap(level, "num");
    if (num === null) return;
    side.numPresent += 1;
    if (num === index) side.numEqualsIndex += 1;
    if (num === index + 1) side.numEqualsIndexPlusOne += 1;
    if (num < 0 || num > 49) side.numOutsideBookRange += 1;
    side.numValues.set(num, (side.numValues.get(num) ?? 0) + 1);
  });
}

function report(name: string, side: SideStats): void {
  if (side.messages === 0) {
    console.info(JSON.stringify({ side: name, messages: 0 }));
    return;
  }
  const share = (count: number): string =>
    `${((100 * count) / Math.max(side.totalLevels, 1)).toFixed(1)}%`;
  const distinct = [...side.numValues.keys()].sort((a, b) => a - b);
  console.info(JSON.stringify({
    side: name,
    messages: side.messages,
    levelsSeen: side.totalLevels,
    arrayLength: { min: side.minArrayLength, max: side.maxArrayLength },
    everSparse: side.minArrayLength < 50,
    numPresent: share(side.numPresent),
    numEqualsArrayIndex: share(side.numEqualsIndex),
    numEqualsIndexPlusOne: share(side.numEqualsIndexPlusOne),
    numOutsideBookRange: side.numOutsideBookRange,
    distinctNumValues: distinct.length,
    numRange: distinct.length > 0 ? [distinct[0], distinct[distinct.length - 1]] : null,
    zeroQtyLevels: side.zeroQtyLevels,
  }, null, 2));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const symbols = (getOption(argv, "symbols") ?? "")
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => symbol !== "");
  if (symbols.length === 0) {
    throw new Error("--symbols=NSE:BANKNIFTY26SEPFUT is required.");
  }
  const seconds = Number(getOption(argv, "seconds") ?? "60");
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--seconds must be a positive number.");
  }

  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  /*
   * Snapshot and delta traffic are counted apart, because pooling them hides the answer.
   * A snapshot is a full ordered 50-level dump by construction, so it always shows
   * `num == index` and never looks sparse -- mixing it in would drag the delta reading toward
   * "nothing to see" no matter what the deltas actually do. Only the delta rows carry evidence.
   */
  const stats = {
    snapshot: { bids: emptySide(), asks: emptySide() },
    delta: { bids: emptySide(), asks: emptySide() },
  };
  let packets = 0;
  let snapshots = 0;

  try {
    const streamer = new FyersTbtDepthStreamer({
      tokenService: new FyersTokenService({
        pool: database,
        appId: environment.FYERS_APP_ID ?? "",
        appSecret: environment.FYERS_APP_SECRET ?? "",
        pin: process.env.FYERS_PIN ?? "",
      }),
      // Wrap the real socket and replace only the book assembly, so the SDK's auth, reconnect and
      // subscribe paths stay exactly as the collector runs them.
      createSocket: (accessToken: string): FyersTbtSocketLike => {
        const require = createRequire(import.meta.url);
        const fyersApi = require("fyers-api-v3") as {
          fyersTbtSocket: new (
            auth: string,
            logPath?: string,
            logging?: boolean,
            diffOnly?: boolean,
          ) => FyersTbtSocketLike & {
            datastore?: {
              updateDepth: (packet: unknown, callback: unknown, diffOnly: unknown) => void;
            };
          };
        };
        const socket = new fyersApi.fyersTbtSocket(accessToken, undefined, false, false);
        const store = socket.datastore;
        if (!store) {
          throw new Error("SDK socket exposes no datastore; the interception point has moved.");
        }
        const original = store.updateDepth.bind(store);
        store.updateDepth = (packet: unknown, callback: unknown, diffOnly: unknown): void => {
          const decoded = packet as { feeds?: Record<string, unknown>; snapshot?: boolean };
          if (decoded?.feeds) {
            packets += 1;
            const isSnapshot = decoded.snapshot === true;
            if (isSnapshot) snapshots += 1;
            const into = isSnapshot ? stats.snapshot : stats.delta;
            for (const feed of Object.values(decoded.feeds)) {
              const depth = (feed as { depth?: { bids?: unknown; asks?: unknown } }).depth;
              if (Array.isArray(depth?.bids)) {
                record(into.bids, depth.bids as Record<string, unknown>[]);
              }
              if (Array.isArray(depth?.asks)) {
                record(into.asks, depth.asks as Record<string, unknown>[]);
              }
            }
          }
          original(packet, callback, diffOnly);
        };
        return socket;
      },
    });

    streamer.subscribe(symbols);
    await streamer.connect();
    await new Promise((resolve) => { setTimeout(resolve, seconds * 1000); });
    streamer.close();

    const deltas = packets - snapshots;
    console.info(JSON.stringify({ packets, snapshots, deltas, symbols, seconds }));
    report("snapshot.bids", stats.snapshot.bids);
    report("snapshot.asks", stats.snapshot.asks);
    report("delta.bids", stats.delta.bids);
    report("delta.asks", stats.delta.asks);

    if (packets === 0) {
      console.info("NO MESSAGES. Market closed, or the contract is dead -- this feed answers a "
        + "dead subscription with silence rather than an error.");
    } else if (deltas === 0) {
      console.info("SNAPSHOT ONLY, so this run answers nothing. A snapshot is a full ordered "
        + "50-level dump by construction and always reads num == index. The corruption arises in "
        + "incremental updates, so this needs a run during live trading (from 09:15 IST).");
    } else {
      console.info("Read the delta.* rows only. Never-sparse with numEqualsArrayIndex near 100% "
        + "means num is merely the position, so the corruption is staleness alone and the fix is "
        + "to clear the book each message. Sparse messages, or numEqualsArrayIndex well under "
        + "100%, mean num is the book level and keying by it is the fix.");
    }
  } finally {
    await database.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
