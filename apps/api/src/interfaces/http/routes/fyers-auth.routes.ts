import type { Express, Request, Response } from "express";
import type { HttpConfiguration } from "../../../config/environment.js";
import { hasFyersAuthorizationCredential, loadEnvironment } from "../../../config/environment.js";
import type { DatabasePool } from "../../../infrastructure/database/database.js";
import {
  createFyersOAuthState,
  verifyFyersOAuthState,
} from "../../../infrastructure/market-data/fyers-oauth.js";
import {
  FyersTokenService,
  redactTokens,
} from "../../../infrastructure/market-data/fyers-token-service.js";
import type { HttpDependencies } from "../dependencies.js";

const SETTINGS_PATH = "/settings";

export function registerFyersAuthRoutes(
  app: Express,
  { database }: Pick<HttpDependencies, "database">,
  httpConfiguration: HttpConfiguration,
): void {
  /**
   * Start browser OAuth. Returns a Fyers authorize URL; the SPA navigates there.
   * Tokens never leave the API — only the authorize URL is returned.
   */
  app.get("/api/v1/fyers/auth/start", (request, response) => {
    const environment = loadEnvironment();
    if (!hasFyersAuthorizationCredential(environment)) {
      response.status(503).json({
        error: "Fyers authorize is not configured.",
        detail: "Set FYERS_APP_ID, FYERS_APP_SECRET, and FYERS_REDIRECT_URI on the API.",
      });
      return;
    }

    const redirectUri = environment.FYERS_REDIRECT_URI!.trim();
    const returnTo = resolveReturnTo(
      typeof request.query.returnTo === "string" ? request.query.returnTo : undefined,
      httpConfiguration.CORS_ORIGINS,
    );
    const state = createFyersOAuthState(environment.FYERS_APP_SECRET!);
    // Encode returnTo in state via a second cookie-free channel: append after a pipe in a
    // companion query param that we store by signing returnTo into a separate HMAC blob.
    // Simpler: put returnTo only in the redirect after callback via a signed companion cookie
    // — but we have no cookie jar. Encode as `state|base64url(returnTo)` and verify state only.
    const stateWithReturn = encodeStateWithReturnTo(state, returnTo);

    const service = new FyersTokenService({
      pool: database as DatabasePool,
      appId: environment.FYERS_APP_ID!,
      appSecret: environment.FYERS_APP_SECRET!,
      pin: environment.FYERS_PIN ?? "",
    });

    response.status(200).json({
      authorizeUrl: service.buildAuthorizeUrl(redirectUri, stateWithReturn),
      redirectUri,
      returnTo,
    });
  });

  /**
   * Fyers redirects here when FYERS_REDIRECT_URI points at the API.
   * Must match the Fyers app console exactly.
   */
  app.get("/api/v1/fyers/auth/callback", async (request, response) => {
    const origins = httpConfiguration.CORS_ORIGINS;
    const defaultReturn = `${origins[0]}${SETTINGS_PATH}`;
    const rawState = typeof request.query.state === "string" ? request.query.state : "";
    const { returnTo } = decodeStateWithReturnTo(rawState, origins, defaultReturn);
    const authCode = typeof request.query.auth_code === "string" ? request.query.auth_code.trim() : "";
    const providerError = firstQueryString(request, ["error", "message"]);

    const result = await completeFyersAuthExchange({
      database: database as DatabasePool,
      authCode,
      rawState,
      origins,
      providerError,
    });

    if (result.ok) {
      redirectSettings(response, result.returnTo, "connected");
      return;
    }
    redirectSettings(response, result.returnTo || defaultReturn, "error", result.error);
  });

  /**
   * SPA path: when FYERS_REDIRECT_URI is the web origin (e.g. http://localhost:3001),
   * the browser lands with ?auth_code=… and the web app POSTs here to finish the exchange.
   */
  app.post("/api/v1/fyers/auth/exchange", async (request, response) => {
    const body = (request.body ?? {}) as { auth_code?: unknown; state?: unknown };
    const authCode = typeof body.auth_code === "string" ? body.auth_code.trim() : "";
    const rawState = typeof body.state === "string" ? body.state : "";
    const origins = httpConfiguration.CORS_ORIGINS;

    const result = await completeFyersAuthExchange({
      database: database as DatabasePool,
      authCode,
      rawState,
      origins,
    });

    if (!result.ok) {
      response.status(result.status).json({ error: result.error, returnTo: result.returnTo });
      return;
    }
    response.status(200).json({ status: "connected", returnTo: result.returnTo });
  });

  /** Clear stored Fyers tokens (lab "logged out"). */
  app.post("/api/v1/fyers/auth/disconnect", async (_request, response) => {
    const environment = loadEnvironment();
    if (!environment.FYERS_APP_ID || !environment.FYERS_APP_SECRET) {
      response.status(503).json({ error: "Fyers credentials are not configured." });
      return;
    }

    try {
      const service = new FyersTokenService({
        pool: database as DatabasePool,
        appId: environment.FYERS_APP_ID,
        appSecret: environment.FYERS_APP_SECRET,
        pin: environment.FYERS_PIN ?? "",
      });
      await service.disconnect();
      response.status(200).json({ status: "disconnected" });
    } catch (error) {
      response.status(500).json({
        error: error instanceof Error ? redactTokens(error.message) : "Disconnect failed.",
      });
    }
  });
}

function firstQueryString(request: Request, keys: string[]): string | null {
  for (const key of keys) {
    const value = request.query[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

async function completeFyersAuthExchange(input: {
  database: DatabasePool;
  authCode: string;
  rawState: string;
  origins: string[];
  providerError?: string | null;
}): Promise<
  | { ok: true; returnTo: string }
  | { ok: false; status: number; error: string; returnTo: string }
> {
  const environment = loadEnvironment();
  const defaultReturn = `${input.origins[0]}${SETTINGS_PATH}`;
  const { state, returnTo } = decodeStateWithReturnTo(input.rawState, input.origins, defaultReturn);

  if (!hasFyersAuthorizationCredential(environment)) {
    return {
      ok: false,
      status: 503,
      error: "Fyers authorize is not configured.",
      returnTo,
    };
  }

  if (!verifyFyersOAuthState(environment.FYERS_APP_SECRET!, state)) {
    return {
      ok: false,
      status: 400,
      error: "OAuth state is invalid or expired. Try Connect again.",
      returnTo,
    };
  }

  if (!input.authCode) {
    return {
      ok: false,
      status: 400,
      error: input.providerError
        ? redactTokens(input.providerError)
        : "Fyers did not return an auth_code.",
      returnTo,
    };
  }

  // Fyers also sends `code=200` as a status field — never treat that as the auth code.
  if (/^\d{3}$/.test(input.authCode)) {
    return {
      ok: false,
      status: 400,
      error: "Received a status code instead of auth_code. Try Connect again.",
      returnTo,
    };
  }

  try {
    const service = new FyersTokenService({
      pool: input.database,
      appId: environment.FYERS_APP_ID!,
      appSecret: environment.FYERS_APP_SECRET!,
      pin: environment.FYERS_PIN ?? "",
    });
    const tokens = await service.exchangeAuthCode(input.authCode);
    await service.storeTokens(tokens);
    return { ok: true, returnTo };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Fyers auth-code exchange failed.";
    return { ok: false, status: 502, error: redactTokens(message), returnTo };
  }
}

function resolveReturnTo(candidate: string | undefined, origins: string[]): string {
  const fallback = `${origins[0]}${SETTINGS_PATH}`;
  if (!candidate?.trim()) return fallback;
  try {
    const url = new URL(candidate.trim());
    if (!origins.includes(url.origin)) return fallback;
    // Settings only — do not open an open redirect into arbitrary paths on the origin.
    if (url.pathname !== SETTINGS_PATH && url.pathname !== `${SETTINGS_PATH}/`) return fallback;
    return `${url.origin}${SETTINGS_PATH}`;
  } catch {
    return fallback;
  }
}

function encodeStateWithReturnTo(state: string, returnTo: string): string {
  const encoded = Buffer.from(returnTo, "utf8").toString("base64url");
  return `${state}.${encoded}`;
}

function decodeStateWithReturnTo(
  raw: string,
  origins: string[],
  fallback: string,
): { state: string; returnTo: string } {
  const parts = raw.split(".");
  // state is issuedAt.nonce.sig — optionally + returnTo base64url
  if (parts.length === 4) {
    const returnEncoded = parts[3]!;
    const state = parts.slice(0, 3).join(".");
    try {
      const returnTo = Buffer.from(returnEncoded, "base64url").toString("utf8");
      return { state, returnTo: resolveReturnTo(returnTo, origins) };
    } catch {
      return { state, returnTo: fallback };
    }
  }
  if (parts.length === 3) {
    return { state: raw, returnTo: fallback };
  }
  return { state: raw, returnTo: fallback };
}

function redirectSettings(
  response: Response,
  returnTo: string,
  status: "connected" | "error",
  message?: string,
): void {
  const url = new URL(returnTo);
  url.searchParams.set("fyers", status);
  if (message) url.searchParams.set("fyersMessage", message.slice(0, 280));
  response.redirect(302, url.toString());
}
