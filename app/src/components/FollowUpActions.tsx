"use client";
import { useEffect, useState } from "react";
import { MessageCircle, Phone, ClipboardCheck, Clock } from "lucide-react";
import { ActionForm, Submit } from "@/components/ActionForm";
import { assignAction, logOutcomeAction, scheduleAction } from "@/app/(app)/actions";
import { normalizePhone } from "@/lib/phone";

const CHANNELS = [["call", "Call"], ["whatsapp", "WhatsApp"], ["email", "Email"], ["sms", "SMS"], ["other", "Other"]] as const;
const OUTCOMES = [
  ["reached", "Spoke to lead"], ["no_answer", "No answer"], ["interested", "Interested"], ["callback_requested", "Callback requested"],
  ["converted", "Converted"], ["not_interested", "Not interested"], ["dropped", "Dropped"],
] as const;

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", k);
    return () => document.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <>
      <div className="sheet-scrim" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label={title}>
        <div className="drawer-head"><h2 style={{ fontSize: 20 }}>{title}</h2><button type="button" className="x" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </div>
    </>
  );
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : "");
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

/** Call / WhatsApp shortcuts plus the result sheet. Opening a link is never treated as proof of contact. */
export function QuickActions({ leadId, name, phone, disabled, compact, logOnly }: { leadId: string; name: string; phone: string | null; disabled?: boolean; compact?: boolean; logOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<string>("call");
  const [outcome, setOutcome] = useState<string>("");
  const [when, setWhen] = useState("");
  const digits = normalizePhone(phone);
  const launch = (c: string) => { setChannel(c); setOpen(true); };

  return (
    <>
      <div className="acts">
        {phone && !disabled && !logOnly && <a className={`chip${compact ? " ico" : ""}`} title="Call" href={`tel:${phone.replace(/[^\d+]/g, "")}`} onClick={() => launch("call")} aria-label={`Call ${name}`}><Phone size={15} />{compact ? "" : "Call"}</a>}
        {digits && !disabled && !logOnly && <a className={`chip${compact ? " ico" : ""}`} title="WhatsApp" href={`https://wa.me/${digits}`} target="_blank" rel="noopener noreferrer" onClick={() => launch("whatsapp")} aria-label={`WhatsApp ${name}`}><MessageCircle size={15} />{compact ? "" : "WhatsApp"}</a>}
        {!disabled && <button type="button" className={logOnly ? "chip" : "chip primary"} onClick={() => launch(channel)}><ClipboardCheck size={15} />Log result</button>}
      </div>
      {open && (
        <Sheet title={`Log result: ${name}`} onClose={() => setOpen(false)}>
          <p className="sub">Opening a call or chat link does not prove it happened. Record what actually happened.</p>
          <ActionForm action={logOutcomeAction} className="panel" onOk={() => { setOpen(false); setOutcome(""); }}>
            <input type="hidden" name="leadId" value={leadId} />
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Channel</legend>
              <div className="opt">{CHANNELS.map(([v, l]) => <label key={v}><input type="radio" name="channel" value={v} checked={channel === v} onChange={() => setChannel(v)} /><span>{l}</span></label>)}</div></fieldset>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="label">Result</legend>
              <div className="opt">{OUTCOMES.map(([v, l]) => <label key={v}><input type="radio" name="outcome" value={v} required checked={outcome === v} onChange={() => setOutcome(v)} /><span>{l}</span></label>)}</div></fieldset>
            {outcome === "callback_requested" && (
              <label className="field"><span>Call back at</span>
                <input type="datetime-local" required min={localInput(new Date())} defaultValue={localInput(new Date(Date.now() + 86400000))} onChange={(e) => setWhen(toIso(e.target.value))} />
                <input type="hidden" name="nextAt" value={when || toIso(localInput(new Date(Date.now() + 86400000)))} /></label>
            )}
            <label className="field"><span>Notes (optional)</span><textarea name="notes" maxLength={2000} /></label>
            <p className="sub">{outcome === "no_answer" ? "The lead stays open and a retry is scheduled." : outcome === "converted" || outcome === "not_interested" || outcome === "dropped" ? "This closes the lead." : "The next follow-up is scheduled for you."}</p>
            <Submit>Save result</Submit>
          </ActionForm>
        </Sheet>
      )}
    </>
  );
}

const PRESETS = [["+4 h", 4], ["Tomorrow", 24], ["+48 h", 48]] as const;

export function RescheduleButton({ leadId, name, disabled, compact }: { leadId: string; name: string; disabled?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const [iso, setIso] = useState("");
  if (disabled) return null;
  return (
    <>
      <button type="button" className={`chip${compact ? " ico" : ""}`} title="Reschedule" onClick={() => setOpen(true)} aria-label={`Reschedule ${name}`}><Clock size={15} />{compact ? "" : "Reschedule"}</button>
      {open && (
        <Sheet title={`Reschedule: ${name}`} onClose={() => setOpen(false)}>
          <ActionForm action={scheduleAction} className="panel" onOk={() => setOpen(false)}>
            <input type="hidden" name="leadId" value={leadId} />
            <div className="opt">{PRESETS.map(([l, h]) => <button key={l} type="button" className="chip" onClick={() => setIso(new Date(Date.now() + h * 3600000).toISOString())}>{l}</button>)}</div>
            <label className="field"><span>Or pick a time</span><input type="datetime-local" min={localInput(new Date())} onChange={(e) => setIso(toIso(e.target.value))} /></label>
            <input type="hidden" name="at" value={iso} />
            <label className="field"><span>Reason (optional)</span><input type="text" name="notes" maxLength={300} /></label>
            <Submit>{iso ? `Reschedule to ${new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Choose a time"}</Submit>
          </ActionForm>
        </Sheet>
      )}
    </>
  );
}

/** Owner picker for managers. Changing it opens a small confirm with an optional reason. */
export function AssignControl({ leadId, ownerId, owners }: { leadId: string; ownerId: string | null; owners: { id: string; name: string }[] }) {
  const [pick, setPick] = useState<string | null>(null);
  return (
    <>
      <label className="field" style={{ minWidth: 110 }}><span className="label" style={{ position: "absolute", left: -9999 }}>Owner</span>
        <select value={ownerId ?? ""} onChange={(e) => setPick(e.target.value)} aria-label="Owner">
          <option value="">Unassigned</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select></label>
      {pick !== null && pick !== (ownerId ?? "") && (
        <Sheet title="Reassign lead" onClose={() => setPick(null)}>
          <ActionForm action={assignAction} className="panel" onOk={() => setPick(null)}>
            <input type="hidden" name="leadId" value={leadId} /><input type="hidden" name="ownerId" value={pick} />
            <p>Assign to <b>{owners.find((o) => o.id === pick)?.name ?? "nobody"}</b>? Their open follow-up moves with the lead.</p>
            <label className="field"><span>Reason (optional)</span><input type="text" name="reason" maxLength={300} /></label>
            <Submit>Confirm</Submit>
          </ActionForm>
        </Sheet>
      )}
    </>
  );
}
