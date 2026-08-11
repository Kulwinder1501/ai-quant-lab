import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const FYERS_AUTHORIZE_PATH = "/api/v3/generate-authcode";
export const FYERS_VALIDATE_AUTHCODE_PATH = "/api/v3/validate-authcode";
export const FYERS_ACCESS_TOKEN_TTL_MS = 8 * 60 * 60_000;
export const FYERS_REFRESH_TOKEN_TTL_MS = 15 * 24 * 60 * 60_000;
/** OAuth `state` lifetime — long enough for a login, short enough to limit replay. */
export const FYERS_OAUTH_STATE_TTL_MS = 10 * 60_000;

/**
 * Build the Fyers login URL. `redirectUri` must match the app registration exactly
 * (including path), or Fyers rejects the authorize step.
 */
export function buildFyersAuthorizeUrl(input: {
  baseUrl: string;
  appId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL(`${input.baseUrl.replace(/\/$/, "")}${FYERS_AUTHORIZE_PATH}`);
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", input.state);
  return url.toString();
}

/**
 * Signed, time-bound CSRF state. Format: `{issuedAtMs}.{nonce}.{hmacHex}`.
 * Signed with the app secret so any API replica can verify without shared memory.
 */
export function createFyersOAuthState(secret: string, nowMs = Date.now()): string {
  const nonce = randomBytes(16).toString("hex");
  const payload = `${nowMs}.${nonce}`;
  const signature = signPayload(secret, payload);
  return `${payload}.${signature}`;
}

export function verifyFyersOAuthState(
  secret: string,
  state: string,
  nowMs = Date.now(),
  ttlMs = FYERS_OAUTH_STATE_TTL_MS,
): boolean {
  const parts = state.split(".");
  if (parts.length !== 3) return false;
  const [issuedAtRaw, nonce, signature] = parts;
  if (!issuedAtRaw || !nonce || !signature) return false;
  if (!/^\d+$/.test(issuedAtRaw) || !/^[a-f0-9]{32}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) {
    return false;
  }
  const issuedAt = Number(issuedAtRaw);
  if (!Number.isFinite(issuedAt) || nowMs - issuedAt > ttlMs || issuedAt > nowMs + 60_000) {
    return false;
  }
  const expected = signPayload(secret, `${issuedAtRaw}.${nonce}`);
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}
