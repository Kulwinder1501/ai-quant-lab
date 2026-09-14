import { redirect } from "next/navigation";

// Swing and scalp ideas now share one page with a mode tab. This route is kept
// so existing bookmarks and the Phase 22 docs still resolve.
export default function ScalpStrategyPage() {
  redirect("/strategy?mode=scalp");
}
