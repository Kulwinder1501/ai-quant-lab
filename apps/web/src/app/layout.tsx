import "./globals.css";
import "lenis/dist/lenis.css";
import type { Metadata } from "next";
import { SmoothScroll } from "../components/ui/smooth-scroll";

export const metadata: Metadata = {
  title: "AI Quant Lab",
  description: "Read-only Indian market scanner, active instrument watchlist, and explainable AI prediction review",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><SmoothScroll>{children}</SmoothScroll></body></html>;
}
