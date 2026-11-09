"use client";
import { useSyncExternalStore } from "react";

type View = "popup" | "page";
const listeners = new Set<() => void>();
const read = (): View => (/(?:^|;\s*)leadview=page/.test(document.cookie) ? "page" : "popup");
const subscribe = (cb: () => void) => { listeners.add(cb); return () => { listeners.delete(cb); }; };

/** Personal choice, kept in this browser: open a lead in a pop-up over the list, or on its own page. */
export function LeadViewToggle() {
  const v = useSyncExternalStore(subscribe, read, () => "popup" as View);
  const set = (x: View) => { document.cookie = `leadview=${x}; path=/; max-age=31536000; samesite=lax`; listeners.forEach((l) => l()); };
  return (
    <div className="chips" style={{ alignItems: "center", alignSelf: "start" }} role="group" aria-label="How leads open">
      <span className="sub">Open leads in:</span>
      <button type="button" className={`chip ${v === "popup" ? "primary" : ""}`} aria-pressed={v === "popup"} onClick={() => set("popup")}>Pop-up</button>
      <button type="button" className={`chip ${v === "page" ? "primary" : ""}`} aria-pressed={v === "page"} onClick={() => set("page")}>Full page</button>
    </div>
  );
}
