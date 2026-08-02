import type { Config } from "tailwindcss";
import colors from "tailwindcss/colors";
import defaultTheme from "tailwindcss/defaultTheme";

const colorShades = ["50", "100", "200", "300", "400", "500", "600", "700", "800", "900", "950"] as const;

function hexToRgb(hex: string) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)).join(" ");
}

function themedScale(name: string, palette: Record<string, string>) {
  return Object.fromEntries(
    colorShades.map((shade) => [
      shade,
      `rgb(var(--color-${name}-${shade}, ${hexToRgb(palette[shade])}) / <alpha-value>)`,
    ]),
  );
}

export default {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        white: "rgb(var(--color-white, 255 255 255) / <alpha-value>)",
        slate: themedScale("slate", colors.slate),
        cyan: themedScale("cyan", colors.cyan),
        emerald: themedScale("emerald", colors.emerald),
        rose: themedScale("rose", colors.rose),
        amber: themedScale("amber", colors.amber),
        blue: themedScale("blue", colors.blue),
        purple: themedScale("purple", colors.purple),
        indigo: themedScale("indigo", colors.indigo),
        orange: themedScale("orange", colors.orange),
        static: {
          white: "#ffffff",
          navy: "#0f172a",
        },
      },
      fontFamily: {
        sans: ["var(--font-inter)", ...defaultTheme.fontFamily.sans],
      },
    },
  },
  plugins: [],
} satisfies Config;
