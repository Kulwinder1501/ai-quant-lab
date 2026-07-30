"use client";

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseApiDataOptions {
  retries?: number;
  retryDelay?: number;
}

export function useApiData<T>(url: string, options: UseApiDataOptions = {}) {
  const { retries = 3, retryDelay = 1000 } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const fetchData = useCallback(async (attempt: number = 1) => {
    setLoading(true);
    setError(null);

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();

    try {
      const response = await fetch(url, { signal: abortControllerRef.current.signal });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const result = await response.json();
      setData(result);
    } catch (err: any) {
      if (err.name === 'AbortError') return;

      if (attempt < retries) {
        setTimeout(() => fetchData(attempt + 1), retryDelay * attempt); // Exponential/Simple backoff
      } else {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      setLoading(false);
    }
  }, [url, retries, retryDelay]);

  useEffect(() => {
    fetchData();
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [fetchData]);

  const refetch = () => fetchData();

  return { data, loading, error, refetch };
}
