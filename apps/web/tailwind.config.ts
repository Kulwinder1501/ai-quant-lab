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
  // The app owns its theme: applyTheme() toggles both data-theme and the `dark`
  // class on <html>. Tailwind's default "media" strategy would key `dark:` off
  // the OS preference instead, which silently disagrees with the in-app toggle.
  darkMode: "class",
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
      /**
       * Price-tick flashes, as one-shot animations rather than timed state.
       *
       * The market-watch panel used to hold the flash in React state and clear it with a
       * `setTimeout`, which fired after unmount and left a flash stuck on whenever two ticks
       * overlapped. An animation that ends on its own needs neither a timer nor a render.
       */
      keyframes: {
        "flash-up": {
          "0%": { backgroundColor: "rgb(16 185 129 / 0.25)" },
          "100%": { backgroundColor: "transparent" },
        },
        "flash-down": {
          "0%": { backgroundColor: "rgb(244 63 94 / 0.25)" },
          "100%": { backgroundColor: "transparent" },
        },
      },
      animation: {
        "flash-up": "flash-up 800ms ease-out 1",
        "flash-down": "flash-down 800ms ease-out 1",
      },
    },
  },
  plugins: [],
} satisfies Config;
