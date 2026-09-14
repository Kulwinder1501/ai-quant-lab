"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { getApiV1Url } from "../../research/api";

/**
 * When FYERS_REDIRECT_URI is the web origin (e.g. http://localhost:3001), Fyers
 * dumps `auth_code` on the homepage. This catcher POSTs it to the API for exchange
 * and then sends the user to Settings — tokens never stay in the browser.
 */
export function FyersAuthCallbackCatcher() {
  const router = useRouter();
  const started = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined" || started.current) return;

    const params = new URLSearchParams(window.location.search);
    const authCode = params.get("auth_code")?.trim();
    const state = params.get("state")?.trim();
    if (!authCode || !state) return;

    started.current = true;

    // Strip secrets from the address bar immediately.
    const clean = new URL(window.location.href);
    clean.searchParams.delete("auth_code");
    clean.searchParams.delete("state");
    clean.searchParams.delete("s");
    clean.searchParams.delete("code");
    window.history.replaceState({}, "", `${clean.pathname}${clean.search}`);

    void (async () => {
      try {
        const response = await fetch(`${getApiV1Url()}/fyers/auth/exchange`, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ auth_code: authCode, state }),
        });
        const payload = await response.json() as {
          status?: string;
          error?: string;
          returnTo?: string;
        };
        if (!response.ok) {
          router.replace(
            `/settings?fyers=error&fyersMessage=${encodeURIComponent(payload.error ?? "Fyers connect failed.")}`,
          );
          return;
        }
        router.replace("/settings?fyers=connected");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Fyers connect failed.";
        router.replace(`/settings?fyers=error&fyersMessage=${encodeURIComponent(message)}`);
      }
    })();
  }, [router]);

  return null;
}
