"use client";

import { useState, useEffect, useRef } from 'react';

const MAX_RECONNECT_ATTEMPTS = 5;

export function useSSE<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Event | null>(null);
  const [connected, setConnected] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let attempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    // Declared as a function so the error handler can re-enter it to reconnect.
    function connect() {
      if (closed) return;

      const es = new EventSource(url);
      eventSourceRef.current = es;

      es.onopen = () => {
        setConnected(true);
        setError(null);
        attempts = 0;
      };

      es.onmessage = (event) => {
        try {
          setData(JSON.parse(event.data) as T);
        } catch (err) {
          console.error('Error parsing SSE data', err);
        }
      };

      es.onerror = (err) => {
        setError(err);
        setConnected(false);
        es.close();

        if (attempts < MAX_RECONNECT_ATTEMPTS) {
          const timeout = Math.min(1000 * Math.pow(2, attempts), 30000);
          attempts += 1;
          reconnectTimer = setTimeout(connect, timeout);
        }
      };
    }

    connect();

    return () => {
      closed = true;
      clearTimeout(reconnectTimer);
      eventSourceRef.current?.close();
    };
  }, [url]);

  return { data, connected, error };
}
