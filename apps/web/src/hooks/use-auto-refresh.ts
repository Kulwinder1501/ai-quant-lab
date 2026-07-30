"use client";

import { useState, useEffect, useCallback } from 'react';

export function useAutoRefresh(callback: () => void, intervalMs: number = 60000) {
  const [timeLeft, setTimeLeft] = useState(Math.ceil(intervalMs / 1000));

  const resetTimer = useCallback(() => {
    setTimeLeft(Math.ceil(intervalMs / 1000));
  }, [intervalMs]);

  useEffect(() => {
    resetTimer();

    const timer = setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          callback();
          return Math.ceil(intervalMs / 1000);
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [callback, intervalMs, resetTimer]);

  return timeLeft;
}
