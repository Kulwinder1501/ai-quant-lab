import { redirect } from "next/navigation";

export default function ScalpTradeHistoryPage() {
  redirect("/trade-history?mode=scalp");
}
