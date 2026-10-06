import { redirect } from "next/navigation";

export default function OrdersPage() {
  redirect("/positions-orders?tab=orders");
}
