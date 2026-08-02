"use client";

import { useState, useEffect, useCallback } from 'react';
import { isAbortError } from '../lib/errors';

interface UseApiDataOptions {
  retries?: number;
  retryDelay?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function useApiData<T>(url: string, options: UseApiDataOptions = {}) {
  const { retries = 3, retryDelay = 1000 } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  // Pure I/O, including the retry loop: an effect can call this without writing
  // state synchronously and cascading a render.
  const load = useCallback(async (signal: AbortSignal): Promise<T> => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        return await response.json() as T;
      } catch (err: unknown) {
        if (isAbortError(err) || attempt >= retries) throw err;
        await sleep(retryDelay * attempt);
      }
    }
  }, [url, retries, retryDelay]);

  const applyData = useCallback((value: T) => {
    setData(value);
    setError(null);
    setLoading(false);
  }, []);

  const applyError = useCallback((err: unknown) => {
    if (isAbortError(err)) return;
    setError(err instanceof Error ? err : new Error(String(err)));
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).then(applyData, applyError);
    return () => controller.abort();
  }, [load, applyData, applyError]);

  const refetch = useCallback(() => {
    setLoading(true);
    const controller = new AbortController();
    void load(controller.signal).then(applyData, applyError);
  }, [load, applyData, applyError]);

  return { data, loading, error, refetch };
}
