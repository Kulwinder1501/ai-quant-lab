import "./globals.css";
import "lenis/dist/lenis.css";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { SmoothScroll } from "../components/ui/smooth-scroll";
import { ThemeProvider } from "../components/theme/theme-provider";
import { THEME_STORAGE_KEY } from "../components/theme/theme-storage";

// Variable font, so every weight from 100-900 is available without listing them.
const inter = Inter({ subsets: ["latin"], display: "swap", variable: "--font-inter" });

export const metadata: Metadata = {
  title: "AI Quant Lab",
  description: "Read-only Indian market scanner, active instrument watchlist, and explainable AI prediction review",
};

const themeBootScript = `
(function () {
  var theme = "dark";
  try {
    var saved = window.localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});
    if (saved === "light" || saved === "dark") theme = saved;
  } catch (_) {}
  var root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
})();`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html className={inter.variable} data-theme="dark" lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        <ThemeProvider>
          <SmoothScroll>{children}</SmoothScroll>
        </ThemeProvider>
      </body>
    </html>
  );
}
