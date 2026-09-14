import { useAppStore } from "../../stores/app-store";

/** Accept either an API root or an already-versioned NEXT_PUBLIC_API_URL. */
export function getApiV1Url(): string {
  const configuredApiUrl = useAppStore.getState().apiBaseUrl.trim().replace(/\/+$/, "");
  return configuredApiUrl.endsWith("/api/v1") ? configuredApiUrl : `${configuredApiUrl}/api/v1`;
}

/**
 * The dashboard uses this transport helper for read-only inspection queries.
 */
export async function getResearchJson(path: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${getApiV1Url()}${path}`, {
    method: "GET",
    headers: { Accept: "application/json" },
    cache: "no-store",
    signal,
  });
  if (!response.ok) {
    let errorMsg = `Request failed with status ${response.status}.`;
    try {
      const errJson = await response.json() as { error?: string };
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }
  return response.json() as Promise<unknown>;
}

/**
 * Transport helper for triggering local quantitative simulations, backtest runs,
 * paper trading actions, and analysis calculation from the dashboard UI.
 */
export async function postResearchJson(path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(`${getApiV1Url()}${path}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!response.ok) {
    let errorMsg = `Request failed with status ${response.status}.`;
    try {
      const errJson = await response.json() as { error?: string };
      if (errJson.error) errorMsg = errJson.error;
    } catch {}
    throw new Error(errorMsg);
  }
  return response.json() as Promise<unknown>;
}
