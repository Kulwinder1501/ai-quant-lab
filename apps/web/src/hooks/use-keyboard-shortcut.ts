"use client";

import { useEffect } from 'react';

type KeyCombo = {
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

export function useKeyboardShortcut(
  combo: KeyCombo,
  callback: (e: KeyboardEvent) => void
) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const keyMatch = event.key.toLowerCase() === combo.key.toLowerCase();
      const ctrlMatch = combo.ctrlKey ? event.ctrlKey : !event.ctrlKey;
      const shiftMatch = combo.shiftKey ? event.shiftKey : !event.shiftKey;
      const altMatch = combo.altKey ? event.altKey : !event.altKey;
      const metaMatch = combo.metaKey ? event.metaKey : !event.metaKey;

      if (keyMatch && ctrlMatch && shiftMatch && altMatch && metaMatch) {
        event.preventDefault();
        callback(event);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [combo, callback]);
}
