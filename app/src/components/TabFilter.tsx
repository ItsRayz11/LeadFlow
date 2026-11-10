"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { MultiSelect, type MSOption } from "@/components/MultiSelect";

export type FilterTab = { key: string; title: string; n: number; state: "syncing" | "waiting" | "paused" | "off" };

const BADGE = { syncing: undefined, waiting: { text: "Waiting", tone: "warn" }, paused: { text: "Paused", tone: "mute" }, off: undefined } as const;

/**
 * "Filter by Sheet Tab". Viewing only: it changes the address (?tab=…) and never touches what is synced from Google Sheets.
 * Empty selection means All tabs, including paused tabs and manually added leads.
 */
export function TabFilter({ tabs, applied, seg, q }: { tabs: FilterTab[]; applied: string[]; seg: string; q: string }) {
  const router = useRouter();
  const [sel, setSel] = useState(() => new Set(applied));
  const options: MSOption[] = tabs.map((t) => ({ value: t.key, label: t.title, meta: `${t.n} lead${t.n === 1 ? "" : "s"}`, badge: BADGE[t.state] as MSOption["badge"] }));

  const go = (keys: string[]) => {
    const p = new URLSearchParams();
    if (seg && seg !== "all") p.set("seg", seg);
    if (q) p.set("q", q);
    if (keys.length) p.set("tab", keys.join(","));
    router.push(`/leads${p.size ? `?${p}` : ""}`);
  };
  const same = sel.size === applied.length && applied.every((k) => sel.has(k));
  const summary = applied.length === 0 ? "All tabs" : `${applied.length} tab${applied.length === 1 ? "" : "s"} selected`;

  return (
    <MultiSelect
      label="Filter by Sheet Tab" options={options} selected={sel} onChange={setSel} summary={summary}
      onClose={() => setSel(new Set(applied))}
      footer={(close) => <>
        <button type="button" className="btn ghost" onClick={() => { setSel(new Set()); go([]); close(); }} disabled={applied.length === 0 && sel.size === 0}>Show all tabs</button>
        <button type="button" className="btn" onClick={() => { go([...sel]); close(); }} disabled={same}>Apply selection</button>
      </>}
    />
  );
}
