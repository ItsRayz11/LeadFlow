"use client";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ChevronDown, Search } from "lucide-react";

export type MSOption = {
  value: string;
  label: string;
  /** Right-aligned small text, e.g. "180 leads". */
  meta?: string;
  /** Status badge, e.g. Syncing. */
  badge?: { text: string; tone: "ok" | "warn" | "mute" | "crit" };
  /** A problem with this option, shown under its name. */
  warning?: string;
  disabled?: boolean;
};

/**
 * Searchable multi-select with checkboxes. The menu floats over the page (no horizontal scrolling, long names wrap).
 * Nothing is selected for you: "Select all" only acts when clicked, and only on the options the search currently shows.
 */
export function MultiSelect({
  label, options, selected, onChange, summary, noun = "tab", footer, onClose, id,
}: {
  label: string; options: MSOption[]; selected: Set<string>; onChange: (next: Set<string>) => void;
  /** Text on the closed control. Defaults to "N tabs selected". */
  summary?: string; noun?: string; footer?: (close: () => void) => React.ReactNode; onClose?: () => void; id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const uid = useId();

  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return n ? options.filter((o) => o.label.toLowerCase().includes(n)) : options;
  }, [options, q]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) { setOpen(false); onClose?.(); } };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { setOpen(false); onClose?.(); btn.current?.focus(); } };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open, onClose]);

  const n = selected.size;
  const text = summary ?? (n === 0 ? `No ${noun}s selected` : `${n} ${noun}${n === 1 ? "" : "s"} selected`);
  const toggle = (v: string) => { const s = new Set(selected); if (s.has(v)) s.delete(v); else s.add(v); onChange(s); };
  const pickable = shown.filter((o) => !o.disabled);
  const allShown = pickable.length > 0 && pickable.every((o) => selected.has(o.value));

  return (
    <div className="ms" ref={root}>
      <span className="ms-label" id={`${uid}-l`}>{label}</span>
      <button ref={btn} type="button" id={id} className="ms-btn" aria-haspopup="true" aria-expanded={open} aria-labelledby={`${uid}-l ${uid}-b`} onClick={() => setOpen((v) => !v)}>
        <span id={`${uid}-b`} className="ms-sum">{text}</span><ChevronDown size={16} aria-hidden />
      </button>
      {open && (
        <div className="ms-menu" role="group" aria-label={label}>
          <div className="ms-search"><Search size={15} aria-hidden />
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${noun}s`} aria-label={`Search ${noun}s`} autoFocus />
          </div>
          <div className="ms-tools">
            <button type="button" className="ms-link" disabled={!pickable.length || allShown} onClick={() => { const s = new Set(selected); pickable.forEach((o) => s.add(o.value)); onChange(s); }}>Select all{q.trim() ? " shown" : ""}</button>
            <button type="button" className="ms-link" disabled={n === 0} onClick={() => onChange(new Set())}>Clear selection</button>
            <span className="ms-count" aria-live="polite">{n} selected</span>
          </div>
          <ul className="ms-list">
            {shown.length === 0 && <li className="ms-empty">No {noun}s match “{q}”.</li>}
            {shown.map((o) => (
              <li key={o.value}>
                <label className={`ms-opt${o.disabled ? " dis" : ""}`}>
                  <input type="checkbox" checked={selected.has(o.value)} disabled={o.disabled} onChange={() => toggle(o.value)} />
                  <span className="ms-name" title={o.label}>
                    {o.label}
                    {o.warning && <small className="ms-warn">{o.warning}</small>}
                  </span>
                  {o.meta && <span className="ms-meta">{o.meta}</span>}
                  {o.badge && <span className={`pill ${o.badge.tone}`}>{o.badge.text}</span>}
                </label>
              </li>
            ))}
          </ul>
          {footer && <div className="ms-foot">{footer(() => setOpen(false))}</div>}
        </div>
      )}
    </div>
  );
}
