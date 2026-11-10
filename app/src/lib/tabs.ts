/**
 * Pure helpers for spreadsheet-tab selection (Integrations) and tab filtering (Leads). No database, no server-only import, so they are unit-testable.
 */

/** A tab key is "<connectionId>:<gid>" (unique across spreadsheets) or a bare gid (legacy links). */
const KEY = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:)?\d{1,12}$/i;

export const tabKey = (connectionId: string, gid: string) => `${connectionId}:${gid}`;

export function splitTabKey(k: string): { connectionId: string | null; gid: string } {
  const i = k.indexOf(":");
  return i < 0 ? { connectionId: null, gid: k } : { connectionId: k.slice(0, i), gid: k.slice(i + 1) };
}

/** Reads the `tab` query value (comma separated, or repeated). Invalid pieces are dropped, duplicates removed. */
export function parseTabKeys(v: string | string[] | undefined | null): string[] {
  const parts = (Array.isArray(v) ? v : [v ?? ""]).flatMap((x) => x.split(","));
  return [...new Set(parts.map((x) => x.trim()).filter((x) => KEY.test(x)))].slice(0, 60);
}

/** Google's own fallback name for a tab we could not name. It is an internal id, never something to show a person. */
const PLACEHOLDER = /^Worksheet \d+$/;
export const isPlaceholderTitle = (t: string | null | undefined) => !t || !t.trim() || PLACEHOLDER.test(t.trim());
export const visibleTabTitle = (t: string | null | undefined) => (isPlaceholderTitle(t) ? "Untitled tab" : t!.trim());

export type TabState = "syncing" | "waiting" | "paused" | "off";
/** syncing = selected and confirmed; waiting = selected, needs confirmation before it imports; paused = was synced, now switched off; off = never selected. */
export function tabState(m: { enabled: boolean; confirmedAt: Date | null } | undefined, everConfirmed = false): TabState {
  if (!m) return "off";
  if (m.enabled) return m.confirmedAt ? "syncing" : "waiting";
  return everConfirmed ? "paused" : "off";
}

/**
 * What saving a selection does. Only tabs that really exist in the spreadsheet can be selected.
 *  stop: currently syncing but no longer ticked (switched off, leads stay)
 *  add:  ticked but not syncing yet (must be validated and then confirmed)
 *  keep: ticked and already syncing (left exactly as they are)
 */
export function planTabSave(ticked: Iterable<string>, existing: Iterable<string>, enabled: Iterable<string>) {
  const real = new Set(existing), on = new Set(enabled);
  const want = new Set([...ticked].filter((g) => real.has(g)));
  return {
    stop: [...on].filter((g) => real.has(g) && !want.has(g)), // a tab missing from the list is never stopped by accident
    add: [...want].filter((g) => !on.has(g)),
    keep: [...want].filter((g) => on.has(g)),
  };
}

export type TabProblem = { gid: string; title: string; reason: string };
export const problemText = (p: TabProblem) => `“${visibleTabTitle(p.title)}” ${p.reason}`;
