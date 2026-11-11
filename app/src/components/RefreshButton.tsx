"use client";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { RefreshCw } from "lucide-react";

export function RefreshButton() {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="iconbtn" aria-label="Refresh" title="Refresh" disabled={pending} onClick={() => start(() => router.refresh())}>
      <RefreshCw size={18} className={pending ? "spin" : ""} />
    </button>
  );
}
