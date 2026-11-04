"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { createLead, type FormState } from "../actions";

/** Fields are controlled on purpose: React resets uncontrolled forms after a server action, which would wipe the input when a duplicate warning comes back. */
export function NewLeadForm({ owners }: { owners: { id: string; name: string }[] }) {
  const [state, action, pending] = useActionState<FormState, FormData>(createLead, undefined);
  const [v, setV] = useState({ name: "", phone: "", email: "", source: "", campaign: "", ownerId: "", force: false });
  const bind = (k: "name" | "phone" | "email" | "source" | "campaign" | "ownerId") => ({
    name: k, value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setV({ ...v, [k]: e.target.value }),
  });
  return (
    <form action={action} className="panel glass" style={{ maxWidth: 560 }}>
      <h2>Add a lead</h2>
      <label className="field"><span>Name</span><input type="text" required {...bind("name")} /></label>
      <label className="field"><span>Phone or WhatsApp</span><input type="text" inputMode="tel" {...bind("phone")} /></label>
      <label className="field"><span>Email</span><input type="text" inputMode="email" {...bind("email")} /></label>
      <div className="grid2" style={{ gap: 10 }}>
        <label className="field"><span>Source</span><input type="text" placeholder="Meta Ads, Referral…" {...bind("source")} /></label>
        <label className="field"><span>Campaign</span><input type="text" {...bind("campaign")} /></label>
      </div>
      {owners.length > 0 && (
        <label className="field"><span>Assign to</span>
          <select {...bind("ownerId")}><option value="">Unassigned</option>{owners.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
        </label>
      )}
      {state?.error && (
        <p className="err" role="alert">
          {state.error}{" "}
          {state.dupId && (
            <>Open <Link href={`/leads/${state.dupId}`} style={{ color: "var(--accent)" }}>{state.dupName}</Link>, or{" "}
              <label style={{ cursor: "pointer" }}><input type="checkbox" name="force" value="1" checked={v.force} onChange={(e) => setV({ ...v, force: e.target.checked })} /> add anyway</label>.</>
          )}
        </p>
      )}
      <div className="chips"><button className="btn" disabled={pending}>{pending ? "Saving" : "Save lead"}</button><Link className="chip" href="/leads">Cancel</Link></div>
    </form>
  );
}
