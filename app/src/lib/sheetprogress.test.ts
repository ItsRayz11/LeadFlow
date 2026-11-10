import { describe, expect, it } from "vitest";
import { cardMilestones, clean, mayApplyProgress, planProgress } from "@/lib/sheetprogress";

describe("reading the sheet's wording", () => {
  it("strips emoji and numbering", () => {
    expect(clean("🕒 24H Follow-up")).toBe("24h follow-up");
    expect(clean("2.🔗 Referral Code Share")).toBe("referral code share");
    expect(clean("  ⭐  Interested ")).toBe("interested");
  });

  it("maps statuses and stages from the real sheet", () => {
    expect(planProgress({ status: "💬 WhatsApp", stage: "🔄 48H Follow-up" })).toMatchObject({ status: "contacted", step: "h48", closeAs: null });
    expect(planProgress({ status: "⭐ Interested", stage: "💬 Contact Started" })).toMatchObject({ status: "interested", step: "contact_started" });
    expect(planProgress({ status: "📵 No Answer", stage: "🕒 24H Follow-up" })).toMatchObject({ status: "no_response", step: "h24", closeAs: null });
    expect(planProgress({ status: null, stage: "⏳ Final Follow-up" })).toMatchObject({ status: null, step: "final" });
  });

  it("closes the lead for final outcomes, and the strongest outcome wins", () => {
    expect(planProgress({ status: "❌ Not Interested" })).toMatchObject({ closeAs: "not_interested", status: "not_interested", step: "completed" });
    expect(planProgress({ stage: "⚪ No Response" })).toMatchObject({ closeAs: "no_response", step: "completed" });
    expect(planProgress({ stage: "🔴 Not Interested", onboarded: "TRUE" })).toMatchObject({ closeAs: "converted" });
    expect(planProgress({ status: "✅ Onboarded" })).toMatchObject({ closeAs: "converted", status: "converted" });
  });

  it("ignores wording it does not know instead of guessing", () => {
    expect(planProgress({ status: "Something new", stage: "???" })).toMatchObject({ status: null, step: null, closeAs: null });
    expect(planProgress({})).toMatchObject({ status: null, step: null, closeAs: null, milestones: [] });
  });

  it("treats card steps as cumulative", () => {
    expect(cardMilestones("1.📲 Downloaded")).toEqual(["appDownloadedAt"]);
    expect(cardMilestones("2.🔗 Referral Code Share")).toEqual(["appDownloadedAt", "referralSharedAt"]);
    expect(cardMilestones("4.💸 Spending")).toHaveLength(4);
    expect(cardMilestones("FALSE")).toEqual([]);
    expect(cardMilestones("")).toEqual([]);
  });

  it("reads the checkboxes", () => {
    expect(planProgress({ salesQualified: "TRUE", completedMeeting: "FALSE" }).flags).toEqual({ salesQualified: true, completedMeeting: false, onboarded: false });
  });
});

describe("a CRM edit always wins", () => {
  const lead = { status: "new", followUpStep: "contact_started", closedAt: null, followUpAttempts: 0, firstContactedAt: null };
  it("takes progress on a lead nobody has touched", () => {
    expect(mayApplyProgress(lead, undefined)).toBe(true);
  });
  it("does not overwrite a lead the team already worked in the CRM, when there is no baseline", () => {
    expect(mayApplyProgress({ ...lead, followUpAttempts: 2 }, undefined)).toBe(false);
    expect(mayApplyProgress({ ...lead, status: "contacted" }, undefined)).toBe(false);
  });
  it("keeps following the sheet while the CRM still matches what the sheet last gave it", () => {
    const base = { status: "contacted", step: "h24", closed: false };
    expect(mayApplyProgress({ ...lead, status: "contacted", followUpStep: "h24" }, base)).toBe(true);
  });
  it("stops following the sheet once someone changed it in the CRM", () => {
    const base = { status: "contacted", step: "h24", closed: false };
    expect(mayApplyProgress({ ...lead, status: "interested", followUpStep: "h24" }, base)).toBe(false);
    expect(mayApplyProgress({ ...lead, status: "contacted", followUpStep: "h48" }, base)).toBe(false);
    expect(mayApplyProgress({ ...lead, status: "contacted", followUpStep: "h24", closedAt: new Date() }, base)).toBe(false);
  });
});
