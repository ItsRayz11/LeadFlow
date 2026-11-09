"use client";
import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

const readPref = () => (typeof document !== "undefined" && /(?:^|;\s*)leadview=page/.test(document.cookie) ? "page" : "popup");

/** A link to a lead. Opens the pop-up by default, or the full page when the person chose that (see LeadViewToggle). */
export function LeadLink({ id, className, style, children }: { id: string; className?: string; style?: CSSProperties; children: ReactNode }) {
  return (
    <Link href={`/leads/${id}`} className={className} style={style}
      onClick={(e) => {
        // A full-page load skips the pop-up. Ctrl/Cmd/Shift-click still opens a new tab/window the normal way.
        if (readPref() === "page" && !e.metaKey && !e.ctrlKey && !e.shiftKey && e.button === 0) { e.preventDefault(); window.location.href = `/leads/${id}`; }
      }}>{children}</Link>
  );
}
