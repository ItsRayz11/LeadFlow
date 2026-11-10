import { indexesOf, type ColumnMap } from "@/lib/sheetparse";

/**
 * Pure rules for writing CRM edits back to a sheet. No database or network, so every rule is unit tested.
 *
 * The same three-way rule the importer uses, mirrored:
 *   base  = what the sheet last said (recorded at the last sync)
 *   crm   = what the CRM says now
 *   cell  = what the sheet says right now
 * CRM changed, sheet did not  -> write the CRM value to the sheet
 * sheet already has the CRM value -> just move the baseline
 * both changed to different values -> record a difference for a person to settle, write nothing
 */

export const WRITE_FIELDS = ["name", "phoneRaw", "email", "campaign", "source"] as const;
export type WriteField = (typeof WRITE_FIELDS)[number];
export type Values = Record<WriteField, string | null>;

export type FieldPlan =
  | { kind: "write"; field: WriteField; col: number; value: string }
  | { kind: "adopt"; field: WriteField }
  | { kind: "conflict"; field: WriteField; sheetValue: string; crmValue: string | null }
  | { kind: "skip"; field: WriteField; reason: string };

const t = (v: string | null | undefined) => (v ?? "").trim();
const norm = (h: string) => h.replace(/\s+/g, " ").trim().toLowerCase();
const looksLikeEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

/** id value -> 1-based sheet row number, for the rows under the header. The first occurrence wins, like the importer. */
export function indexRows(table: string[][], headerRow: number, idCols: number[]): Map<string, number> {
  const out = new Map<string, number>();
  for (let n = headerRow + 1; n < table.length; n++) {
    const r = table[n] ?? [];
    for (const i of idCols) {
      const v = t(r[i]);
      if (v) { if (!out.has(v)) out.set(v, n + 1); break; }
    }
  }
  return out;
}

/** Which column holds a lead's phone or email, judged from the headers and the cells themselves. 0-based index, or null. */
function contactColumn(kind: "phone" | "email", headers: string[], contact: number[], cells: string[], current: string | null): number | null {
  const isMailCol = (i: number) => norm(headers[i] ?? "").includes("mail");
  const fits = (i: number) => (kind === "email" ? isMailCol(i) || looksLikeEmail(t(cells[i])) : !isMailCol(i) && !looksLikeEmail(t(cells[i])));
  const pool = contact.filter(fits);
  const cur = t(current);
  if (cur) { const hit = pool.find((i) => t(cells[i]) === cur); if (hit !== undefined) return hit; }
  const filled = pool.find((i) => t(cells[i]));
  if (filled !== undefined) return filled; // the sheet has something there that is not the old value: a difference to look at
  return pool[0] ?? null;
}

export function planLeadWrites(input: {
  table: string[][]; headerRow: number; rowNumber: number; map: ColumnMap; base: Values; crm: Values; openConflicts: ReadonlySet<string>;
}): FieldPlan[] {
  const { table, headerRow, rowNumber, map, base, crm, openConflicts } = input;
  const headers = (table[headerRow] ?? []).map((h) => h ?? "");
  const cells = table[rowNumber - 1] ?? [];
  const contact = map.contact.flatMap((c) => indexesOf(headers, c));
  const plans: FieldPlan[] = [];

  for (const field of WRITE_FIELDS) {
    const b = t(base[field]), c = t(crm[field]);
    if (b === c) continue;
    if (openConflicts.has(field)) { plans.push({ kind: "skip", field, reason: "an open difference must be settled first" }); continue; }
    let col: number | null;
    if (field === "name") col = indexesOf(headers, map.name)[0] ?? null;
    else if (field === "campaign") col = indexesOf(headers, map.campaign)[0] ?? null;
    else if (field === "source") col = indexesOf(headers, map.source)[0] ?? null;
    else col = contactColumn(field === "email" ? "email" : "phone", headers, contact, cells, base[field]);
    if (col === null) { plans.push({ kind: "skip", field, reason: "no matching column in the sheet" }); continue; }
    const cur = t(cells[col]);
    if (cur === c) plans.push({ kind: "adopt", field });
    else if (cur === b) plans.push({ kind: "write", field, col: col + 1, value: c });
    else plans.push({ kind: "conflict", field, sheetValue: cur, crmValue: crm[field] ?? null });
  }
  return plans;
}

/** A new sheet row for a lead created in the CRM, laid out by the sheet's own header order. Unknown columns stay empty. */
export function buildNewRow(
  headers: string[], map: ColumnMap, v: { externalId: string; name: string; phone: string | null; email: string | null; campaign: string | null; source: string | null; created: string },
): string[] | null {
  const row = new Array<string>(headers.length).fill("");
  const idCol = indexesOf(headers, map.externalId)[0], nameCol = indexesOf(headers, map.name)[0];
  if (idCol === undefined || nameCol === undefined) return null;
  row[idCol] = v.externalId; row[nameCol] = v.name;
  const put = (header: string | undefined, val: string | null) => { const i = indexesOf(headers, header)[0]; if (i !== undefined && val) row[i] = val; };
  put(map.acquiredAt, v.created); put(map.campaign, v.campaign); put(map.source, v.source);
  const contact = map.contact.flatMap((c) => indexesOf(headers, c));
  const phoneCol = contact.find((i) => !norm(headers[i] ?? "").includes("mail"));
  const mailCol = contact.find((i) => norm(headers[i] ?? "").includes("mail"));
  if (v.phone && phoneCol !== undefined) row[phoneCol] = v.phone;
  if (v.email && mailCol !== undefined) row[mailCol] = v.email;
  return row;
}
