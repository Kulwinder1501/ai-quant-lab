"use client";

import { useEffect, useState } from "react";

function pageProgress(): number {
  const scrollableHeight = document.documentElement.scrollHeight - window.innerHeight;
  if (scrollableHeight <= 0) return 0;
  return Math.min(Math.max(window.scrollY / scrollableHeight, 0), 1);
}

/** A small source-owned scroll affordance; it does not observe or change app data. */
export function ScrollProgress() {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let frame: number | undefined;
    const update = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        setProgress(pageProgress());
        frame = undefined;
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div aria-hidden="true" className="fixed inset-x-0 top-0 z-50 h-px bg-slate-950/40">
      <div
        className="h-full origin-left bg-gradient-to-r from-cyan-300 via-sky-400 to-indigo-400 transition-transform duration-150 motion-reduce:transition-none"
        style={{ transform: `scaleX(${progress})` }}
      />
    </div>
  );
}
