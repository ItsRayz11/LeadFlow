import { indexesOf } from "@/lib/sheetparse";
import { clean, type ProgressBase } from "@/lib/sheetprogress";

/**
 * Writing the CRM's status and follow-up stage back into the sheet's own dropdown wording (emoji and all).
 * Pure functions: the exact text is learned from what the sheet already uses, so chips keep rendering.
 */

const DEFAULT_STATUS: Record<string, string> = {
  whatsapp: "💬 WhatsApp", interested: "⭐ Interested", "not interested": "❌ Not Interested", "no answer": "📵 No Answer", onboarded: "✅ Onboarded",
};
const DEFAULT_STAGE: Record<string, string> = {
  "contact started": "💬 Contact Started", "24h follow-up": "🕒 24H Follow-up", "48h follow-up": "🔄 48H Follow-up", "final follow-up": "⏳ Final Follow-up",
  "not interested": "🔴 Not Interested", "no response": "⚪ No Response",
};

export type Labels = { status: Record<string, string>; stage: Record<string, string> };

/** The most common spelling already used in the sheet for each value, keyed by its plain wording. */
export function learnLabels(table: string[][], headerRow: number, statusHeader: string | undefined, stageHeader: string | undefined): Labels {
  const headers = (table[headerRow] ?? []).map((h) => h ?? "");
  const pick = (header: string | undefined, defaults: Record<string, string>) => {
    const counts = new Map<string, Map<string, number>>();
    for (const i of indexesOf(headers, header)) {
      for (let n = headerRow + 1; n < table.length; n++) {
        const raw = (table[n]?.[i] ?? "").trim();
        const key = raw && clean(raw);
        if (!raw || !defaults[key]) continue; // only values we understand
        const m = counts.get(key) ?? new Map<string, number>();
        m.set(raw, (m.get(raw) ?? 0) + 1); counts.set(key, m);
      }
    }
    const out = { ...defaults };
    for (const [k, m] of counts) out[k] = [...m].sort((a, b) => b[1] - a[1])[0][0];
    return out;
  };
  return { status: pick(statusHeader, DEFAULT_STATUS), stage: pick(stageHeader, DEFAULT_STAGE) };
}

export type CrmProgress = { status: string; step: string; closed: boolean; outcome: string | null };

const STATUS_KEY: Record<string, string> = { contacted: "whatsapp", interested: "interested", not_interested: "not interested", no_response: "no answer", converted: "onboarded" };
const STAGE_KEY: Record<string, string> = { contact_started: "contact started", h24: "24h follow-up", h48: "48h follow-up", final: "final follow-up" };

/** What the sheet's two cells should say for this lead. null means "the sheet has no wording for this: leave the cell alone". */
export function desiredCells(c: CrmProgress, labels: Labels): { status: string | null; stage: string | null } {
  const s = (k: string | undefined) => (k ? labels.status[k] ?? null : null);
  const g = (k: string | undefined) => (k ? labels.stage[k] ?? null : null);
  if (c.closed) {
    if (c.outcome === "converted") return { status: s("onboarded"), stage: null };
    if (c.outcome === "not_interested") return { status: s("not interested"), stage: g("not interested") };
    if (c.outcome === "no_response") return { status: null, stage: g("no response") };
    return { status: null, stage: null };
  }
  return { status: s(STATUS_KEY[c.status]), stage: g(STAGE_KEY[c.step]) };
}

export type Seen = { status: string; stage: string };
export type ProgressWrite =
  | { kind: "none" }
  | { kind: "adopt" } // the sheet already agrees, or the CRM state has no sheet wording: only the bookkeeping moves
  | { kind: "write"; status?: string; stage?: string }
  | { kind: "conflict"; sheetText: string; crmText: string };

export const sheetText = (s: Seen) => `${s.status.trim() || "(blank)"} | ${s.stage.trim() || "(blank)"}`;
export const parseSheetText = (v: string): Seen => {
  const [a = "", b = ""] = v.split(" | ");
  return { status: a === "(blank)" ? "" : a, stage: b === "(blank)" ? "" : b };
};

/**
 * The same three-way rule as every other field:
 *   base = the CRM state the sheet last gave it, t0 = the sheet's cells at that time, cells = the sheet's cells now.
 * CRM changed and the sheet did not -> write. Both changed and they disagree -> a person decides. Nothing is ever overwritten silently.
 */
export function planProgressWrite(i: { crm: CrmProgress; base: ProgressBase; t0: Seen; cells: Seen; labels: Labels; hasStatusCol: boolean; hasStageCol: boolean }): ProgressWrite {
  const { crm, base, t0, cells, labels } = i;
  if (crm.status === base.status && crm.step === base.step && crm.closed === base.closed) return { kind: "none" };
  const want = desiredCells(crm, labels);
  const wantStatus = i.hasStatusCol ? want.status : null;
  const wantStage = i.hasStageCol ? want.stage : null;
  const differs = (w: string | null, cell: string) => w !== null && clean(w) !== clean(cell);
  const sheetChanged = (i.hasStatusCol && clean(cells.status) !== clean(t0.status)) || (i.hasStageCol && clean(cells.stage) !== clean(t0.stage));
  const needStatus = differs(wantStatus, cells.status), needStage = differs(wantStage, cells.stage);
  if (!needStatus && !needStage) return { kind: "adopt" };
  if (sheetChanged) return { kind: "conflict", sheetText: sheetText(cells), crmText: sheetText({ status: wantStatus ?? cells.status, stage: wantStage ?? cells.stage }) };
  return { kind: "write", ...(needStatus ? { status: wantStatus! } : {}), ...(needStage ? { stage: wantStage! } : {}) };
}
