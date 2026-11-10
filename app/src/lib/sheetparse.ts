import { normalizePhone } from "@/lib/phone";

/** Pure helpers for reading a worksheet. No database or network access, so they are unit tested. */

export type ColumnMap = {
  externalId: string; // persistent lead id column (never a row number)
  name: string;
  acquiredAt?: string;
  campaign?: string;
  source?: string;
  owner?: string; // free-text name resolved through identity aliases
  sheetStatus?: string; // kept for display only; the CRM owns status
  contact: string[]; // every column that may hold a phone or an email
  // Progress the team already tracks in the sheet. All optional: a tab without them still imports.
  followUp?: string; // stage: Contact Started, 24H, 48H, Final, Not Interested, No Response
  notes?: string;
  cardStatus?: string; // 1.Downloaded ... 4.Spending
  salesQualified?: string; // checkbox columns
  completedMeeting?: string;
  onboarded?: string;
  referralCode?: string;
};

export const DEFAULT_COLUMN_MAP: ColumnMap = {
  externalId: "id",
  name: "full_name",
  acquiredAt: "created_time",
  campaign: "campaign_name",
  source: "platform",
  owner: "Contacted y",
  sheetStatus: "Status",
  contact: ["whatsapp_number", "phone_number", "email"],
  followUp: "Lead Follow Up",
  notes: "Notes",
  cardStatus: "Card Status",
  salesQualified: "sales qualified",
  completedMeeting: "completed meeting",
  onboarded: "onboarded",
  referralCode: "referral code",
};

export function parseSheetUrl(input: string): { spreadsheetId: string; gid: string | null } | null {
  const m = input.trim().match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (!m) return null;
  const gid = input.match(/[#?&]gid=(\d+)/)?.[1] ?? null;
  return { spreadsheetId: m[1], gid };
}

/** Reads the tab names and ids out of a link-shared sheet's public "htmlview" page. Returns [] when the page lists none (for example a private sheet). */
export function parseTabList(html: string): { gid: string; title: string }[] {
  const unescape = (s: string) =>
    s.replace(/\\x([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\(.)/g, "$1");
  const out: { gid: string; title: string }[] = [];
  const seen = new Set<string>();
  const re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:\s*"(?:[^"\\]|\\.)*",\s*gid:\s*"(\d+)"/g;
  for (const m of html.matchAll(re)) {
    if (seen.has(m[2])) continue;
    seen.add(m[2]);
    out.push({ gid: m[2], title: unescape(m[1]).trim() || `Worksheet ${m[2]}` });
  }
  return out;
}

/** RFC 4180 CSV: quoted fields, escaped quotes, and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], f = "", q = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(f); f = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(f); f = ""; rows.push(row); row = [];
    } else f += ch;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const norm = (h: string) => h.replace(/\s+/g, " ").trim().toLowerCase();

/** Column indexes for a header name. Duplicate headers (e.g. two "whatsapp_number") all match. */
export function indexesOf(headers: string[], name: string | undefined): number[] {
  if (!name) return [];
  const n = norm(name);
  return headers.flatMap((h, i) => (norm(h) === n ? [i] : []));
}

/** Strips emoji, digits and punctuation: "📄 Fazal" -> "Fazal". */
export function cleanAlias(v: string): string {
  return v.replace(/[^\p{L}\p{M}\s'.-]/gu, "").replace(/\s+/g, " ").trim();
}

export function parseSheetDate(v: string, tz: string, toUtc: (local: string, tz: string) => Date): Date | null {
  const t = v.trim();
  if (!t) return null;
  const time = String.raw`(?:[ T]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?)?`;
  let y: number, mo: number, d: number, hh = 12, mm = 0, ap: string | undefined;
  let m = t.match(new RegExp(String.raw`^(\d{1,2})/(\d{1,2})/(\d{4})` + time)); // M/D/YYYY (Google Sheets, US locale)
  if (m) { mo = +m[1]; d = +m[2]; y = +m[3]; if (m[4]) { hh = +m[4]; mm = +m[5]; ap = m[6]; } }
  else if ((m = t.match(new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})` + time)))) { y = +m[1]; mo = +m[2]; d = +m[3]; if (m[4]) { hh = +m[4]; mm = +m[5]; ap = m[6]; } }
  else return null;
  if (ap) {
    if (hh < 1 || hh > 12) return null;
    hh = (hh % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 23 || mm > 59) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  const dt = toUtc(`${y}-${p(mo)}-${p(d)}T${p(hh)}:${p(mm)}:00`, tz);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export type ParsedRow = {
  externalId: string;
  name: string;
  phoneRaw: string | null;
  phoneNorm: string | null;
  email: string | null;
  emailNorm: string | null;
  campaign: string | null;
  source: string | null;
  ownerAlias: string | null;
  sheetStatus: string | null;
  acquiredAt: Date | null;
  raw: Record<string, string>;
  /** Raw progress cells; turned into CRM fields by sheetprogress. */
  progress: { stage: string | null; notes: string | null; card: string | null; salesQualified: string | null; completedMeeting: string | null; onboarded: string | null; referralCode: string | null };
};

export type ParseResult = { rows: ParsedRow[]; skipped: { reason: string; count: number }[]; missingColumns: string[]; headers: string[] };

export function parseWorksheet(
  table: string[][], map: ColumnMap, tz: string, toUtc: (local: string, tz: string) => Date, headerRow = 0,
): ParseResult {
  const headers = (table[headerRow] ?? []).map((h) => h ?? "");
  const missing: string[] = [];
  const need = (label: string, name: string | undefined, required: boolean) => {
    const ix = indexesOf(headers, name);
    if (!ix.length && required) missing.push(`${label} (“${name}”)`);
    return ix;
  };
  const idIx = need("Lead ID", map.externalId, true);
  const nameIx = need("Name", map.name, true);
  const dateIx = need("Created", map.acquiredAt, false);
  const campIx = need("Campaign", map.campaign, false);
  const srcIx = need("Source", map.source, false);
  const ownIx = need("Owner", map.owner, false);
  const stIx = need("Status", map.sheetStatus, false);
  const prog = {
    stage: indexesOf(headers, map.followUp), notes: indexesOf(headers, map.notes), card: indexesOf(headers, map.cardStatus),
    salesQualified: indexesOf(headers, map.salesQualified), completedMeeting: indexesOf(headers, map.completedMeeting),
    onboarded: indexesOf(headers, map.onboarded), referralCode: indexesOf(headers, map.referralCode),
  };
  const contactIx = map.contact.flatMap((c) => indexesOf(headers, c));
  if (missing.length) return { rows: [], skipped: [], missingColumns: missing, headers };

  const skipped = new Map<string, number>();
  const bump = (r: string) => skipped.set(r, (skipped.get(r) ?? 0) + 1);
  const out: ParsedRow[] = [];
  const seenIds = new Set<string>();
  const first = (r: string[], ix: number[]) => { for (const i of ix) { const v = (r[i] ?? "").trim(); if (v) return v; } return ""; };

  for (let n = headerRow + 1; n < table.length; n++) {
    const r = table[n];
    if (!r || r.every((c) => !c.trim() || /^false$/i.test(c.trim()))) continue; // blank filler rows, including rows that only hold empty checkboxes
    const externalId = first(r, idIx);
    const name = first(r, nameIx);
    if (!externalId) { bump("no lead id"); continue; }
    // A big numeric id formatted as 1.23E+17 has lost digits; different leads would collide. Refuse instead of guessing.
    if (/^\d+(\.\d+)?e\+?\d+$/i.test(externalId)) { bump("id in scientific notation (format the id column as plain text)"); continue; }
    if (!name) { bump("no name"); continue; }
    if (seenIds.has(externalId)) { bump("repeated lead id"); continue; }
    seenIds.add(externalId);

    const cells = contactIx.map((i) => (r[i] ?? "").trim()).filter(Boolean);
    const email = cells.find((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)) ?? null;
    const phoneRaw = cells.find((c) => !c.includes("@") && normalizePhone(c)) ?? null;
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => { const v = (r[i] ?? "").trim(); if (h.trim() && v) raw[raw[h.trim()] === undefined ? h.trim() : `${h.trim()}#${i}`] = v.slice(0, 500); });

    const ownerText = first(r, ownIx);
    out.push({
      externalId, name: name.slice(0, 200), phoneRaw, phoneNorm: normalizePhone(phoneRaw), email, emailNorm: email ? email.toLowerCase() : null,
      campaign: first(r, campIx) || null, source: first(r, srcIx) || null,
      ownerAlias: ownerText ? cleanAlias(ownerText) || null : null,
      sheetStatus: first(r, stIx) || null,
      acquiredAt: parseSheetDate(first(r, dateIx), tz, toUtc), raw,
      progress: {
        stage: first(r, prog.stage) || null, notes: first(r, prog.notes).slice(0, 2000) || null, card: first(r, prog.card) || null,
        salesQualified: first(r, prog.salesQualified) || null, completedMeeting: first(r, prog.completedMeeting) || null,
        onboarded: first(r, prog.onboarded) || null, referralCode: first(r, prog.referralCode) || null,
      },
    });
  }
  return { rows: out, skipped: [...skipped].map(([reason, count]) => ({ reason, count })), missingColumns: [], headers };
}
