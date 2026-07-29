"use client";

import { Children, useEffect, useRef, useState, type ReactNode } from "react";
import { classNames } from "./class-names";

interface RevealProps {
  children: ReactNode;
  className?: string;
  delayMs?: number;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Intersection-observer reveal inspired by motion UI patterns. In reduced
 * motion mode it immediately renders content without movement.
 */
export function Reveal({ children, className, delayMs = 0 }: RevealProps) {
  const node = useRef<HTMLDivElement>(null);
  // SSR and no-JavaScript users receive visible content. We only conceal an
  // element after hydration when it is confirmed to begin offscreen.
  const [concealed, setConcealed] = useState(false);

  useEffect(() => {
    if (prefersReducedMotion() || !("IntersectionObserver" in window)) {
      return;
    }
    const element = node.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (rect.top <= window.innerHeight * 0.94) {
      return;
    }

    setConcealed(true);
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setConcealed(false);
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.04 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      className={classNames(
        "transition-[opacity,transform] duration-500 ease-out motion-reduce:translate-y-0 motion-reduce:opacity-100 motion-reduce:transition-none",
        concealed ? "translate-y-4 opacity-0" : "translate-y-0 opacity-100",
        className,
      )}
      ref={node}
      style={{ transitionDelay: `${delayMs}ms` }}
    >
      {children}
    </div>
  );
}

interface StaggerProps {
  children: ReactNode;
  className?: string;
  intervalMs?: number;
}

export function Stagger({ children, className, intervalMs = 70 }: StaggerProps) {
  return (
    <>
      {Children.toArray(children).map((child, index) => (
        <Reveal className={className} delayMs={index * intervalMs} key={index}>
          {child}
        </Reveal>
      ))}
    </>
  );
}
