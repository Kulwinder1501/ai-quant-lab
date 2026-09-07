import { describe, expect, it } from "vitest";
import {
  buildFyersAuthorizeUrl,
  createFyersOAuthState,
  verifyFyersOAuthState,
} from "./fyers-oauth.js";

describe("buildFyersAuthorizeUrl", () => {
  it("includes client_id, redirect_uri, response_type, and state", () => {
    const url = new URL(buildFyersAuthorizeUrl({
      baseUrl: "https://api-t1.fyers.in",
      appId: "ABC-100",
      redirectUri: "http://localhost:4001/api/v1/fyers/auth/callback",
      state: "state-value",
    }));
    expect(url.origin + url.pathname).toBe("https://api-t1.fyers.in/api/v3/generate-authcode");
    expect(url.searchParams.get("client_id")).toBe("ABC-100");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:4001/api/v1/fyers/auth/callback",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
  });
});

describe("Fyers OAuth state", () => {
  const secret = "test-app-secret";

  it("round-trips a fresh state", () => {
    const now = 1_700_000_000_000;
    const state = createFyersOAuthState(secret, now);
    expect(verifyFyersOAuthState(secret, state, now)).toBe(true);
  });

  it("rejects a tampered signature", () => {
    const now = 1_700_000_000_000;
    const state = createFyersOAuthState(secret, now);
    const parts = state.split(".");
    parts[2] = "a".repeat(64);
    expect(verifyFyersOAuthState(secret, parts.join("."), now)).toBe(false);
  });

  it("rejects an expired state", () => {
    const issued = 1_700_000_000_000;
    const state = createFyersOAuthState(secret, issued);
    expect(verifyFyersOAuthState(secret, state, issued + 11 * 60_000)).toBe(false);
  });

  it("rejects a state signed with a different secret", () => {
    const now = 1_700_000_000_000;
    const state = createFyersOAuthState(secret, now);
    expect(verifyFyersOAuthState("other-secret", state, now)).toBe(false);
  });
});
