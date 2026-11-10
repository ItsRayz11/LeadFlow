"use client";
import { useActionState, useState } from "react";
import { MultiSelect, type MSOption } from "@/components/MultiSelect";
import { Submit } from "@/components/ActionForm";
import type { TabSaveResult } from "@/lib/tabsave";
import type { TabState } from "@/lib/tabs";

export type PickerTab = { gid: string; title: string; state: TabState; hint?: string; locked?: boolean };

const BADGE: Record<TabState, NonNullable<MSOption["badge"]>> = {
  syncing: { text: "Syncing", tone: "ok" },
  waiting: { text: "Needs confirmation", tone: "warn" },
  paused: { text: "Paused", tone: "mute" },
  off: { text: "Not selected", tone: "mute" },
};

/**
 * "Google Sheets Tabs to Sync". The ticked tabs are exactly what gets saved: nothing is pre-ticked except what is already saved as selected,
 * and "Select all" only acts when clicked. Saving validates only the ticked tabs; a bad tab gets its own warning and never blocks the good ones.
 */
export function TabSyncPicker({
  action, hidden, tabs, initial, saveLabel = "Save tabs", note,
}: {
  action: (prev: TabSaveResult, fd: FormData) => Promise<TabSaveResult>;
  hidden: Record<string, string>; tabs: PickerTab[]; initial: string[]; saveLabel?: string; note?: string;
}) {
  const [state, run] = useActionState(action, undefined);
  const sig = initial.join(",");
  const [seen, setSeen] = useState(sig);
  const [sel, setSel] = useState(() => new Set(initial));
  const [warn, setWarn] = useState<Record<string, string>>({});
  const [lastState, setLastState] = useState(state);

  // Re-sync from the server whenever the saved selection changes (derived during render, so there is no stale flash).
  if (seen !== sig) { setSeen(sig); setSel(new Set(initial)); }
  // A tab that failed validation is not syncing: untick it and keep its warning next to its name.
  if (lastState !== state) {
    setLastState(state);
    const w = state?.warnings ?? {};
    setWarn(w);
    if (Object.keys(w).length) setSel((cur) => new Set([...cur].filter((g) => !(g in w))));
  }

  const options: MSOption[] = tabs.map((t) => ({
    value: t.gid, label: t.title, badge: BADGE[t.state], disabled: t.locked,
    warning: warn[t.gid] ? `Cannot sync: ${warn[t.gid]}` : t.hint,
  }));

  return (
    <form action={run} className="tabpick">
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {[...sel].map((g) => <input key={g} type="hidden" name="gid" value={g} />)}
      <MultiSelect label="Google Sheets Tabs to Sync" options={options} selected={sel} onChange={(s) => { setSel(s); setWarn({}); }} />
      <div style={{ marginTop: 10 }}><Submit pendingText="Saving tabs">{saveLabel}</Submit></div>
      {state?.error && <p className="err" role="alert">{state.error}</p>}
      {state?.ok && state.message && <p className="ok-msg" role="status">{state.message}</p>}
      {note && <p className="sub">{note}</p>}
    </form>
  );
}
