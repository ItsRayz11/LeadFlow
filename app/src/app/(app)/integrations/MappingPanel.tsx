import { ActionForm, Submit } from "@/components/ActionForm";
import { previewWorksheet } from "@/lib/sheetops";
import { DEFAULT_COLUMN_MAP, type ColumnMap } from "@/lib/sheetparse";
import { confirmMappingAction, saveMappingAction } from "./actions";

type Mapping = { id: string; sheetGid: string; sheetTitle: string; headerRow: number; columnMap: unknown; confirmedAt: Date | null };

function Pick({ name, label, value, headers, optional }: { name: string; label: string; value?: string; headers: string[]; optional?: boolean }) {
  return (
    <label className="field"><span>{label}</span>
      <select name={name} defaultValue={value && headers.some((h) => h.toLowerCase() === value.toLowerCase()) ? headers.find((h) => h.toLowerCase() === value.toLowerCase()) : ""} required={!optional}>
        {optional ? <option value="">Not used</option> : <option value="" disabled>Choose a column</option>}
        {headers.map((h) => <option key={h} value={h}>{h}</option>)}
      </select></label>
  );
}

/** Shows what a mapping would import (headers, counts, three sample rows) and lets a manager change it. Nothing is imported from here. */
export async function MappingPanel({ spreadsheetId, m, tz, show }: { spreadsheetId: string; m: Mapping; tz: string; show: boolean }) {
  const map = { ...DEFAULT_COLUMN_MAP, ...(m.columnMap as Partial<ColumnMap>) } as ColumnMap;
  // A confirmed mapping previews only on request: reading the sheet on every view is slow and can hit Google rate limits.
  if (!show) return null;
  let pv: Awaited<ReturnType<typeof previewWorksheet>> | null = null;
  let err: string | null = null;
  try { pv = await previewWorksheet(spreadsheetId, m.sheetGid, map, m.headerRow, tz); } catch (e) { err = e instanceof Error ? e.message : "Could not read the sheet."; }

  return (
    <div className="icard glass">
      <h2>{m.sheetTitle} {m.confirmedAt ? <span className="pill ok">Mapped</span> : <span className="pill warn">Not confirmed</span>}</h2>
      <p className="sub">Leads are identified by the “{map.externalId}” column, never by row number.</p>
      {err && <p className="err" role="alert">{err}</p>}
      {pv && (
        <>
          {pv.missing.length > 0 && <p className="err" role="alert">Columns not found: {pv.missing.join(", ")}. Fix the mapping below.</p>}
          <p className="sub">{pv.valid} importable rows{pv.skipped.length ? `. Skipped: ${pv.skipped.map((s) => `${s.count} × ${s.reason}`).join("; ")}` : ""}.</p>
          {pv.sample.length > 0 && (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead><tr><th>Lead id</th><th>Name</th><th>Phone</th><th>Email</th><th>Source</th><th>Owner in sheet</th><th>Arrived</th></tr></thead>
                <tbody>
                  {pv.sample.map((r) => (
                    <tr key={r.externalId}><td>{r.externalId}</td><td>{r.name}</td><td>{r.phoneRaw ?? "–"}</td><td>{r.email ?? "–"}</td><td>{r.source ?? "–"}</td><td>{r.ownerAlias ?? "–"}</td>
                      <td>{r.acquiredAt ? r.acquiredAt.toLocaleDateString([], { timeZone: tz }) : "no date"}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <details style={{ marginTop: 10 }}>
            <summary>Change the column mapping</summary>
            <ActionForm action={saveMappingAction} className="grid2">
              <input type="hidden" name="mappingId" value={m.id} />
              <Pick name="externalId" label="Lead id (must be stable and unique)" value={map.externalId} headers={pv.headers} />
              <Pick name="name" label="Name" value={map.name} headers={pv.headers} />
              <Pick name="acquiredAt" label="Date the lead arrived" value={map.acquiredAt} headers={pv.headers} optional />
              <Pick name="campaign" label="Campaign" value={map.campaign} headers={pv.headers} optional />
              <Pick name="source" label="Source" value={map.source} headers={pv.headers} optional />
              <Pick name="owner" label="Owner name" value={map.owner} headers={pv.headers} optional />
              <Pick name="sheetStatus" label="Status in the sheet (display only)" value={map.sheetStatus} headers={pv.headers} optional />
              <label className="field"><span>Phone and email columns (hold Ctrl or Cmd to pick several)</span>
                <select name="contact" multiple size={Math.min(6, Math.max(3, pv.headers.length))} defaultValue={pv.headers.filter((h) => map.contact.some((c) => c.toLowerCase() === h.toLowerCase()))}>
                  {pv.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                </select></label>
              <label className="field"><span>Header row number</span><input type="number" name="headerRow" min={1} max={20} defaultValue={m.headerRow} /></label>
              <div><Submit>Save mapping</Submit><p className="sub">Saving asks for a new confirmation before anything is imported.</p></div>
            </ActionForm>
          </details>
        </>
      )}
      {!m.confirmedAt && pv && pv.missing.length === 0 && (
        <ActionForm action={confirmMappingAction}><input type="hidden" name="mappingId" value={m.id} /><Submit pendingText="Importing">Confirm mapping and import</Submit></ActionForm>
      )}
    </div>
  );
}
