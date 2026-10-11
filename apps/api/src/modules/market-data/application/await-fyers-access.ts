export interface AwaitFyersAccessOptions {
  /** Give up after this long. */
  maxWaitMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, error: string) => void;
}

export interface AwaitFyersAccessResult {
  available: boolean;
  attempts: number;
  lastError?: string;
}

/**
 * Waits for Fyers to hand out an access token, polling until `maxWaitMs` has passed.
 *
 * Fyers' refresh endpoint can refuse for a while with code -16 ("disabled to comply with SEBI
 * regulations") while the credential is otherwise fine; it has recovered after as little as 19
 * minutes. A batch job that calls Fyers once per instrument fails every one of those calls
 * instantly during such a window -- on 2026-10-08 that was 31 failed EOD collection steps from a
 * single refusal. Waiting once up front turns that into a bounded delay when the provider
 * recovers, and a single reported failure when it does not.
 */
export async function awaitFyersAccess(
  getAccessToken: () => Promise<unknown>,
  options: AwaitFyersAccessOptions,
): Promise<AwaitFyersAccessResult> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  const deadline = now() + options.maxWaitMs;

  let attempts = 0;
  let lastError: string | undefined;
  for (;;) {
    attempts += 1;
    try {
      await getAccessToken();
      return { available: true, attempts };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (now() + options.pollIntervalMs >= deadline) {
      return { available: false, attempts, lastError };
    }
    options.onRetry?.(attempts, lastError);
    await sleep(options.pollIntervalMs);
  }
}
