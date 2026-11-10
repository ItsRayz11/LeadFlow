/**
 * Lead Flow: tell the app the moment this sheet changes.
 *
 * Setup (once, in the sheet):
 *   1. Extensions -> Apps Script. Delete any code there and paste this whole file.
 *   2. Fill in APP_URL and WEBHOOK_SECRET below. The secret must equal SHEET_WEBHOOK_SECRET in the app's settings.
 *   3. Pick the function "install" in the toolbar and press Run. Approve the permissions when asked.
 *   4. To check it, press Run on "testPing". The Executions page shows the app's reply.
 *
 * Safety net: even if a notification is missed, the app re-reads the sheet every few minutes.
 */
const APP_URL = "https://YOUR-APP-DOMAIN"; // no trailing slash
const WEBHOOK_SECRET = "PASTE-SHEET_WEBHOOK_SECRET-HERE";

function notifyApp() {
  // If another notification is already being sent, skip this one: that call will read the newest sheet anyway.
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return;
  try {
    const res = UrlFetchApp.fetch(APP_URL + "/api/sheet/webhook", {
      method: "post",
      contentType: "application/json",
      headers: { "x-webhook-secret": WEBHOOK_SECRET },
      payload: JSON.stringify({ spreadsheetId: SpreadsheetApp.getActiveSpreadsheet().getId() }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() !== 200) console.error("Lead Flow replied " + res.getResponseCode() + ": " + res.getContentText());
  } finally {
    lock.releaseLock();
  }
}

/** Creates the two triggers: any edit, and structural changes such as an inserted row. Safe to run again. */
function install() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === "notifyApp").forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("notifyApp").forSpreadsheet(ss).onEdit().create();
  ScriptApp.newTrigger("notifyApp").forSpreadsheet(ss).onChange().create();
}

function testPing() {
  notifyApp();
}
