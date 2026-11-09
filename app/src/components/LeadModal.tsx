"use client";
import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";

/** Shows the lead over the current page. Closing (button, Escape, clicking outside, browser Back) returns to the list exactly as it was. */
export function LeadModal({ id, children }: { id: string; children: React.ReactNode }) {
  const router = useRouter();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") router.back(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    box.current?.focus();
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = prev; };
  }, [router]);
  return (
    <>
      <div className="sheet-scrim" onClick={() => router.back()} aria-hidden />
      <div className="sheet lead-modal" role="dialog" aria-modal="true" aria-label="Lead details" ref={box} tabIndex={-1}>
        <div className="acts" style={{ justifyContent: "space-between" }}>
          <a className="chip" href={`/leads/${id}`}>Open as full page</a>
          <button type="button" className="chip" onClick={() => router.back()}>Close</button>
        </div>
        {children}
      </div>
    </>
  );
}
