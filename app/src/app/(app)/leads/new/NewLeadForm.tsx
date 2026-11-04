"use client";
import Link from "next/link";
import { useActionState } from "react";
import { createLead, type FormState } from "../actions";

export function NewLeadForm({ owners }: { owners: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createLead, undefined);
  return (
    <form action={action} className="panel glass" style={{ maxWidth: 560 }}>
      <h2>Add a lead</h2>
      <label className="field"><span>Name</span><input type="text" name="name" required /></label>
      <label className="field"><span>Phone or WhatsApp</span><input type="text" name="phone" inputMode="tel" /></label>
      <label className="field"><span>Email</span><input type="text" name="email" inputMode="email" /></label>
      <div className="grid2" style={{ gap: 10 }}>
        <label className="field"><span>Source</span><input type="text" name="source" placeholder="Meta Ads, Referral…" /></label>
        <label className="field"><span>Campaign</span><input type="text" name="campaign" /></label>
      </div>
      {owners.length > 0 && (
        <label className="field"><span>Assign to</span>
          <select name="ownerId" defaultValue=""><option value="">Unassigned</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        </label>
      )}
      {state?.error && (
        <p className="err" role="alert">
          {state.error}{" "}
          {state.dupId && <>Open <Link href={`/leads/${state.dupId}`} style={{ color: "var(--accent)" }}>{state.dupName}</Link>, or <label style={{ cursor: "pointer" }}><input type="checkbox" name="force" value="1" /> add anyway</label>.</>}
        </p>
      )}
      <div className="chips"><button className="btn" disabled={pending}>{pending ? "Saving" : "Save lead"}</button><Link className="chip" href="/leads">Cancel</Link></div>
    </form>
  );
}
