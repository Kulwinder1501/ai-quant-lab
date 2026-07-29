"use client";

import { ReactLenis } from "lenis/react";
import { useEffect, useState, type ReactNode } from "react";

interface SmoothScrollProps {
  children: ReactNode;
}

/**
 * Lenis is enabled only after hydration and is disabled for people who request
 * reduced motion. The dashboard remains fully functional with native scrolling.
 */
export function SmoothScroll({ children }: SmoothScrollProps) {
  const [reducedMotion, setReducedMotion] = useState(true);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updatePreference = () => setReducedMotion(mediaQuery.matches);
    updatePreference();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", updatePreference);
      return () => mediaQuery.removeEventListener("change", updatePreference);
    }

    // `addListener` is only present in older WebKit, so it is intentionally
    // modeled outside TypeScript's modern MediaQueryList definition.
    const legacyMediaQuery = mediaQuery as unknown as {
      addListener(listener: () => void): void;
      removeListener(listener: () => void): void;
    };
    legacyMediaQuery.addListener(updatePreference);
    return () => legacyMediaQuery.removeListener(updatePreference);
  }, []);

  if (reducedMotion) {
    return <>{children}</>;
  }

  return (
    <ReactLenis
      root
      options={{
        anchors: true,
        autoRaf: true,
        lerp: 0.09,
        syncTouch: false,
        wheelMultiplier: 0.9,
      }}
    >
      {children}
    </ReactLenis>
  );
}
