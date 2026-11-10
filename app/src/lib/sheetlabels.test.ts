import { describe, expect, it } from "vitest";
import { desiredCells, learnLabels, parseSheetText, planProgressWrite, sheetText, type CrmProgress } from "@/lib/sheetlabels";

const table = [
  ["Status", "Lead Follow Up "],
  ["💬 WhatsApp", "🔄 48H Follow-up"],
  ["💬 WhatsApp", ""],
  ["💬  Whatsapp", "🔄 48H Follow-up"],
  ["⭐ Interested", "⏳ Final Follow-up"],
];
const labels = learnLabels(table, 0, "Status", "Lead Follow Up");
const crm = (o: Partial<CrmProgress>): CrmProgress => ({ status: "contacted", step: "h24", closed: false, outcome: null, ...o });
const base = { status: "contacted", step: "h24", closed: false };
const t0 = { status: "💬 WhatsApp", stage: "🕒 24H Follow-up" };

describe("sheet wording", () => {
  it("uses the spelling already in the sheet, and falls back to defaults for unseen values", () => {
    expect(labels.status.whatsapp).toBe("💬 WhatsApp"); // the most common spelling wins
    expect(labels.stage["48h follow-up"]).toBe("🔄 48H Follow-up");
    expect(labels.status["not interested"]).toBe("❌ Not Interested"); // never seen: default
  });

  it("says what each CRM state looks like in the sheet", () => {
    expect(desiredCells(crm({ status: "interested", step: "final" }), labels)).toEqual({ status: "⭐ Interested", stage: "⏳ Final Follow-up" });
    expect(desiredCells(crm({ status: "converted", closed: true, outcome: "converted", step: "completed" }), labels)).toEqual({ status: "✅ Onboarded", stage: null });
    expect(desiredCells(crm({ status: "not_interested", closed: true, outcome: "not_interested", step: "completed" }), labels)).toEqual({ status: "❌ Not Interested", stage: "🔴 Not Interested" });
    expect(desiredCells(crm({ status: "no_response", closed: true, outcome: "no_response", step: "completed" }), labels)).toEqual({ status: null, stage: "⚪ No Response" });
  });

  it("leaves a cell alone when the sheet has no wording for the CRM state", () => {
    expect(desiredCells(crm({ status: "proposal_sent", step: "h24" }), labels).status).toBeNull();
    expect(desiredCells(crm({ status: "new", step: "contact_started" }), labels).status).toBeNull();
  });
});

describe("writing status and stage back", () => {
  const plan = (c: CrmProgress, cells = t0, t = t0) => planProgressWrite({ crm: c, base, t0: t, cells, labels, hasStatusCol: true, hasStageCol: true });

  it("does nothing while the CRM still matches what the sheet gave it", () => {
    expect(plan(crm({}))).toEqual({ kind: "none" });
  });

  it("writes the CRM change when the sheet did not change", () => {
    expect(plan(crm({ status: "interested", step: "h48" }))).toEqual({ kind: "write", status: "⭐ Interested", stage: "🔄 48H Follow-up" });
    expect(plan(crm({ step: "h48" }))).toEqual({ kind: "write", stage: "🔄 48H Follow-up" }); // only the cell that differs
  });

  it("raises a difference instead of overwriting when both sides changed", () => {
    const r = plan(crm({ status: "interested", step: "h24" }), { status: "📵 No Answer", stage: "🕒 24H Follow-up" });
    expect(r).toEqual({ kind: "conflict", sheetText: "📵 No Answer | 🕒 24H Follow-up", crmText: "⭐ Interested | 🕒 24H Follow-up" });
  });

  it("only moves the bookkeeping when the sheet already says the same thing", () => {
    expect(plan(crm({ status: "interested" }), { status: "⭐ Interested", stage: "🕒 24H Follow-up" })).toEqual({ kind: "adopt" });
  });

  it("moves the bookkeeping, writing nothing, when the CRM state has no sheet wording", () => {
    expect(plan(crm({ status: "proposal_sent", step: "h24" }))).toEqual({ kind: "adopt" });
  });

  it("ignores a column the tab does not have", () => {
    const r = planProgressWrite({ crm: crm({ status: "interested", step: "h48" }), base, t0, cells: { status: "", stage: t0.stage }, labels, hasStatusCol: false, hasStageCol: true });
    expect(r).toEqual({ kind: "write", stage: "🔄 48H Follow-up" });
  });

  it("round-trips the difference text", () => {
    expect(parseSheetText(sheetText({ status: "⭐ Interested", stage: "" }))).toEqual({ status: "⭐ Interested", stage: "" });
  });
});
