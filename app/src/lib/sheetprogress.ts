/**
 * Turns the progress a team already tracks in the sheet (Status, Lead Follow Up, Card Status, checkboxes) into CRM fields.
 * Pure functions: no database, no network. Unknown wording is ignored, never guessed.
 */

export type LeadStatus = "new" | "contacted" | "interested" | "proposal_sent" | "converted" | "not_interested" | "no_response" | "cold";
export type Step = "contact_started" | "h24" | "h48" | "final" | "completed";
export type Milestone = "appDownloadedAt" | "referralSharedAt" | "cardPurchasedAt" | "spendingStartedAt";
export type CloseAs = "converted" | "not_interested" | "no_response";

export const MILESTONES: Milestone[] = ["appDownloadedAt", "referralSharedAt", "cardPurchasedAt", "spendingStartedAt"];

/** Lower-case words only: emoji, numbering ("2.") and extra spaces are removed. "🕒 24H Follow-up" -> "24h follow-up". */
export function clean(v: string | null | undefined): string {
  return (v ?? "").replace(/[\p{Extended_Pictographic}️‍]/gu, "").replace(/^\s*\d+\s*[.)]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const STATUS: Record<string, { status?: LeadStatus; close?: CloseAs }> = {
  "whatsapp": { status: "contacted" },
  "interested": { status: "interested" },
  "not interested": { close: "not_interested" },
  "no answer": { status: "no_response" },
  "onboarded": { close: "converted" },
};

const STAGE: Record<string, { step?: Step; close?: CloseAs }> = {
  "contact started": { step: "contact_started" },
  "24h follow-up": { step: "h24" },
  "48h follow-up": { step: "h48" },
  "final follow-up": { step: "final" },
  "not interested": { close: "not_interested" },
  "no response": { close: "no_response" },
};

/** "1.📲 Downloaded" -> first milestone; "4.💸 Spending" -> all four. Steps are cumulative, as in the real flow. */
export function cardMilestones(text: string | null | undefined): Milestone[] {
  const raw = (text ?? "").trim();
  const n = Number(raw.match(/^\s*(\d)\s*[.)]/)?.[1]);
  if (n >= 1 && n <= 4) return MILESTONES.slice(0, n);
  const t = clean(raw);
  if (t.includes("spending")) return MILESTONES.slice(0, 4);
  if (t.includes("purchase") || t.includes("bought")) return MILESTONES.slice(0, 3);
  if (t.includes("referral")) return MILESTONES.slice(0, 2);
  if (t.includes("download")) return MILESTONES.slice(0, 1);
  return [];
}

export const isTrue = (v: string | null | undefined) => (v ?? "").trim().toLowerCase() === "true";

export type Progress = {
  status: LeadStatus | null; // null: leave the CRM status alone
  step: Step | null;
  closeAs: CloseAs | null;
  milestones: Milestone[];
  flags: { salesQualified: boolean; completedMeeting: boolean; onboarded: boolean };
};

/** Which final outcome wins when columns disagree: onboarded, then not interested, then no response. */
const RANK: CloseAs[] = ["converted", "not_interested", "no_response"];

export function planProgress(i: { status?: string | null; stage?: string | null; card?: string | null; salesQualified?: string | null; completedMeeting?: string | null; onboarded?: string | null }): Progress {
  const s = STATUS[clean(i.status)] ?? {};
  const g = STAGE[clean(i.stage)] ?? {};
  const flags = { salesQualified: isTrue(i.salesQualified), completedMeeting: isTrue(i.completedMeeting), onboarded: isTrue(i.onboarded) };
  const closes = [s.close, g.close, flags.onboarded ? ("converted" as const) : undefined].filter((x): x is CloseAs => !!x);
  const closeAs = RANK.find((c) => closes.includes(c)) ?? null;
  return {
    closeAs,
    status: closeAs ?? s.status ?? null,
    step: closeAs ? "completed" : g.step ?? null,
    milestones: cardMilestones(i.card),
    flags,
  };
}

export type LeadState = { status: string; followUpStep: string; closedAt: Date | null; followUpAttempts: number; firstContactedAt: Date | null };
export type ProgressBase = { status: string; step: string; closed: boolean };

export const stateOf = (l: LeadState): ProgressBase => ({ status: l.status, step: l.followUpStep, closed: !!l.closedAt });

/**
 * The CRM only takes the sheet's progress while the team has not changed it here:
 * either the lead still matches what the sheet last gave it, or it was never touched. A CRM edit always wins.
 */
export function mayApplyProgress(l: LeadState, base: ProgressBase | undefined): boolean {
  if (base) { const cur = stateOf(l); return cur.status === base.status && cur.step === base.step && cur.closed === base.closed; }
  return l.status === "new" && l.followUpStep === "contact_started" && !l.closedAt && l.followUpAttempts === 0 && !l.firstContactedAt;
}
