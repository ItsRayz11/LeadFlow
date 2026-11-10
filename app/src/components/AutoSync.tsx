"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { autoSyncAction } from "@/app/(app)/autosync";

/** While the app is open, syncs with Google Sheets (both ways) every 10 minutes and refreshes the page data if anything ran. */
export function AutoSync() {
  const router = useRouter();
  useEffect(() => {
    const run = async () => {
      if (document.visibilityState !== "visible") return;
      try { if (await autoSyncAction()) router.refresh(); } catch { /* next tick retries */ }
    };
    const id = setInterval(run, 10 * 60_000);
    const onVisible = () => { if (document.visibilityState === "visible") void run(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [router]);
  return null;
}
