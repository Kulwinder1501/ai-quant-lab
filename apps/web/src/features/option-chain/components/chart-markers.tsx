import React from "react";

interface DotProps {
  cx?: number;
  cy?: number;
}

/**
 * A Recharts `dot` renderer. Call = circle, put = square, so the two sides stay distinguishable
 * without relying on colour. A gap (a null value) arrives without coordinates and renders nothing.
 */
export function markerRenderer(shape: "circle" | "square", color: string, hollow = false) {
  // Hollow = outline only, used for a second source (the provider's own values) beside ours, so the two
  // are told apart by the shape's fill and not by colour alone.
  const fill = hollow ? "#0f172a" : color;
  const stroke = hollow ? color : "#0f172a";
  function Marker({ cx, cy }: DotProps): React.ReactElement {
    if (typeof cx !== "number" || typeof cy !== "number" || !Number.isFinite(cx) || !Number.isFinite(cy)) {
      return <g />;
    }
    return shape === "circle" ? (
      <circle cx={cx} cy={cy} r={3.5} fill={fill} stroke={stroke} strokeWidth={hollow ? 1.5 : 1} />
    ) : (
      <rect x={cx - 3.5} y={cy - 3.5} width={7} height={7} fill={fill} stroke={stroke} strokeWidth={hollow ? 1.5 : 1} />
    );
  }
  return Marker;
}
