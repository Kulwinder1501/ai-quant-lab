import React from "react";

interface DotProps {
  cx?: number;
  cy?: number;
}

/**
 * A Recharts `dot` renderer. Call = circle, put = square, so the two sides stay distinguishable
 * without relying on colour. A gap (a null value) arrives without coordinates and renders nothing.
 */
export function markerRenderer(shape: "circle" | "square", color: string) {
  function Marker({ cx, cy }: DotProps): React.ReactElement {
    if (typeof cx !== "number" || typeof cy !== "number" || !Number.isFinite(cx) || !Number.isFinite(cy)) {
      return <g />;
    }
    return shape === "circle" ? (
      <circle cx={cx} cy={cy} r={3.5} fill={color} stroke="#0f172a" strokeWidth={1} />
    ) : (
      <rect x={cx - 3.5} y={cy - 3.5} width={7} height={7} fill={color} stroke="#0f172a" strokeWidth={1} />
    );
  }
  return Marker;
}
