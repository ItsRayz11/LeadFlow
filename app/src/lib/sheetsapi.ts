import "server-only";
import { createSign } from "node:crypto";

/**
 * Minimal Google Sheets v4 client that signs in as a service account (no OAuth screen, no extra package).
 * Reads work for any sheet shared with the service account; writes need Editor access.
 */

const SCOPE = "https://www.googleapis.com/auth/spreadsheets";
const API = "https://sheets.googleapis.com/v4/spreadsheets";

/** The sheet is not reachable with the service account (not shared, wrong id, or API disabled). Callers may fall back to the public CSV. */
export class SheetsAccessError extends Error {}
/** Out of time or a temporary Google failure; try again later. */
export class SheetsTransientError extends Error {}

export function serviceAccountEmail(): string | null {
  return process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL?.trim() || null;
}

function privateKey(): string | null {
  const raw = process.env.GOOGLE_PRIVATE_KEY?.trim();
  if (!raw) return null;
  // Hosts store the key on one line with literal "\n"; some wrap it in quotes.
  return raw.replace(/^"|"$/g, "").replace(/\\n/g, "\n");
}

export const serviceAccountConfigured = () => !!serviceAccountEmail() && !!privateKey();

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Builds the signed JWT Google exchanges for an access token. Exported for tests. */
export function buildAssertion(email: string, key: string, nowSec: number, tokenUri = "https://oauth2.googleapis.com/token"): string {
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: email, scope: SCOPE, aud: tokenUri, iat: nowSec, exp: nowSec + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(key);
  return `${head}.${body}.${b64url(sig)}`;
}

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(signal?: AbortSignal): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const email = serviceAccountEmail(), key = privateKey();
  if (!email || !key) throw new SheetsAccessError("Google service account is not configured.");
  const assertion = buildAssertion(email, key, Math.floor(Date.now() / 1000));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", signal: signal ?? AbortSignal.timeout(15_000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!res.ok) {
    if (res.status >= 500 || res.status === 429) throw new SheetsTransientError(`Google sign-in returned ${res.status}`);
    throw new SheetsAccessError("Google rejected the service account key. Check GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_PRIVATE_KEY.");
  }
  const j = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
  return j.access_token;
}

async function call<T>(path: string, init: RequestInit & { deadline?: number } = {}): Promise<T> {
  const { deadline, ...fetchInit } = init;
  const left = deadline ? deadline - Date.now() : 20_000;
  if (left < 2_000) throw new SheetsTransientError("Out of time for this run.");
  const signal = AbortSignal.timeout(Math.min(20_000, left));
  const token = await accessToken(signal);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { ...fetchInit, signal, cache: "no-store", headers: { ...fetchInit.headers, authorization: `Bearer ${token}`, "content-type": "application/json" } });
  } catch { throw new SheetsTransientError("Google could not be reached."); }
  if (res.ok) return (await res.json()) as T;
  if (res.status === 401) cached = null;
  if (res.status === 429 || res.status >= 500) throw new SheetsTransientError(`Google returned ${res.status}`);
  const email = serviceAccountEmail() ?? "the service account";
  if (res.status === 403 || res.status === 404) {
    throw new SheetsAccessError(`Google Sheets denied access (${res.status}). Share the sheet with ${email} as Editor and make sure the Google Sheets API is enabled.`);
  }
  throw new SheetsAccessError(`Google Sheets returned ${res.status}.`);
}

const quote = (title: string) => `'${title.replace(/'/g, "''")}'`;
const enc = encodeURIComponent;

const tabCache = new Map<string, { at: number; tabs: { gid: string; title: string }[] }>();

/** Tab names and ids. Cached for a minute so a sync of many tabs makes one metadata call. */
export async function listTabsApi(spreadsheetId: string, deadline?: number, fresh = false): Promise<{ gid: string; title: string }[]> {
  const hit = tabCache.get(spreadsheetId);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.tabs;
  const j = await call<{ sheets?: { properties: { sheetId: number; title: string } }[] }>(
    `/${enc(spreadsheetId)}?fields=sheets.properties(sheetId,title)`, { deadline });
  const tabs = (j.sheets ?? []).map((s) => ({ gid: String(s.properties.sheetId), title: s.properties.title }));
  tabCache.set(spreadsheetId, { at: Date.now(), tabs });
  return tabs;
}

export async function tabTitle(spreadsheetId: string, gid: string, deadline?: number): Promise<string> {
  let t = (await listTabsApi(spreadsheetId, deadline)).find((x) => x.gid === gid);
  if (!t) t = (await listTabsApi(spreadsheetId, deadline, true)).find((x) => x.gid === gid); // a tab added in the last minute
  if (!t) throw new SheetsAccessError("That tab no longer exists in the spreadsheet.");
  return t.title;
}

/** The whole tab as rows of text, the same shape the CSV reader returns. Dates and numbers come back as displayed in the sheet. */
export async function readTableApi(spreadsheetId: string, gid: string, deadline?: number): Promise<string[][]> {
  const title = await tabTitle(spreadsheetId, gid, deadline);
  const range = `/${enc(spreadsheetId)}/values/${enc(quote(title))}?majorDimension=ROWS&valueRenderOption=`;
  const j = await call<{ values?: unknown[][] }>(`${range}FORMATTED_VALUE`, { deadline });
  let rows = (j.values ?? []).map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))));
  // A long number in a numeric cell is displayed as 2.56708E+15, which loses digits. The sheet still holds the exact value,
  // so for those cells only, read the underlying number (when it is a whole number JavaScript can hold exactly).
  if (rows.some((r) => r.some((c) => SCI.test(c)))) {
    const raw = await call<{ values?: unknown[][] }>(`${range}UNFORMATTED_VALUE`, { deadline });
    rows = rows.map((r, i) => r.map((c, k) => {
      if (!SCI.test(c)) return c;
      const u = raw.values?.[i]?.[k];
      return typeof u === "number" && Number.isSafeInteger(u) ? String(u) : c;
    }));
  }
  return rows;
}

const SCI = /^\d+(\.\d+)?e\+?\d+$/i;

/** 1 -> A, 27 -> AA */
export function colLetter(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Writes single cells. `col` and `row` are 1-based. Values are stored as typed text (RAW), so "=…" is never run as a formula. */
export async function writeCellsApi(spreadsheetId: string, gid: string, cells: { row: number; col: number; value: string }[], deadline?: number): Promise<void> {
  if (!cells.length) return;
  const title = await tabTitle(spreadsheetId, gid, deadline);
  await call(`/${enc(spreadsheetId)}/values:batchUpdate`, {
    method: "POST", deadline,
    body: JSON.stringify({
      valueInputOption: "RAW",
      data: cells.map((c) => ({ range: `${quote(title)}!${colLetter(c.col)}${c.row}`, values: [[c.value]] })),
    }),
  });
}

/** Adds rows under the last row that has data. */
export async function appendRowsApi(spreadsheetId: string, gid: string, rows: string[][], deadline?: number): Promise<void> {
  if (!rows.length) return;
  const title = await tabTitle(spreadsheetId, gid, deadline);
  await call(`/${enc(spreadsheetId)}/values/${enc(`${quote(title)}!A1`)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
    method: "POST", deadline, body: JSON.stringify({ majorDimension: "ROWS", values: rows }),
  });
}
