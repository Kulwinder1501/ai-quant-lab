"use client";

import { useState, useEffect, useRef } from 'react';

export function useAutoRefresh(callback: () => void, intervalMs: number = 60000) {
  const seconds = Math.max(1, Math.ceil(intervalMs / 1000));
  const [timeLeft, setTimeLeft] = useState(seconds);
  // Held in a ref so a caller passing an inline arrow does not restart the countdown
  // on every render.
  const callbackRef = useRef(callback);
  const remainingRef = useRef(seconds);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    remainingRef.current = seconds;

    const timer = setInterval(() => {
      remainingRef.current -= 1;
      if (remainingRef.current <= 0) {
        remainingRef.current = seconds;
        callbackRef.current();
      }
      setTimeLeft(remainingRef.current);
    }, 1000);

    return () => clearInterval(timer);
  }, [seconds]);

  return timeLeft;
}
