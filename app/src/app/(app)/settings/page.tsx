import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db, schema } from "@/db";
import { canManage, requireCtx } from "@/lib/session";
import { readSettings } from "@/lib/schedule";
import { externalChannels } from "@/lib/notify";
import { ActionForm, Submit } from "@/components/ActionForm";
import { settingsAction } from "../team/actions";
import { LeadViewToggle } from "@/components/LeadViewToggle";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const c = await requireCtx();
  if (!canManage(c)) notFound();
  const [w] = await db.select().from(schema.workspace).where(eq(schema.workspace.id, c.workspaceId));
  const s = readSettings(w.settings);
  const admin = c.role === "admin";
  const ext = externalChannels();
  const lastSweep = (w.settings as { lastSweepAt?: string } | null)?.lastSweepAt;

  const N = ({ name, label, value, unit }: { name: string; label: string; value: number; unit: string }) => (
    <label className="field"><span>{label}</span><input type="number" name={name} defaultValue={value} min={0} step="any" required /><small className="sub">{unit}</small></label>
  );

  return (
    <>
      <header className="top"><div><h1>Settings</h1><p>{admin ? "Follow-up timing, reminders and time zone." : "Read-only. Only admins can change these."}</p></div></header>
      <ActionForm action={settingsAction} className="grid2">
        <fieldset disabled={!admin} style={{ border: 0, padding: 0, margin: 0, display: "contents" }}>
          <section className="panel glass">
            <h2>Follow-up schedule</h2>
            <p className="sub">After a contact is confirmed, the next follow-up is scheduled this many calendar days later, and again after each completed follow-up. A date picked by hand is never changed automatically.</p>
            <N name="firstContactMin" label="First contact due after assignment" value={s.firstContactMin} unit="minutes" />
            <N name="followUpDays" label="Follow-up interval" value={s.followUpDays} unit="calendar days" />
            <input type="hidden" name="h24" value={s.h24} /><input type="hidden" name="h48" value={s.h48} /><input type="hidden" name="hFinal" value={s.hFinal} />
            <N name="minGapMin" label="Never schedule sooner than" value={s.minGapMin} unit="minutes from now" />
          </section>
          <section className="panel glass">
            <h2>Unanswered attempts and escalation</h2>
            <N name="retryNoAnswerMin" label="Retry after no answer" value={s.retryNoAnswerMin} unit="minutes" />
            <N name="maxNoAnswer" label="Move on after this many unanswered attempts" value={s.maxNoAnswer} unit="attempts. The lead is never closed automatically." />
            <N name="escalateAfterMin" label="Escalate to managers when overdue by" value={s.escalateAfterMin} unit="minutes" />
            <N name="advanceReminderMin" label="Advance reminder" value={s.advanceReminderMin} unit="minutes before due. 0 turns it off." />
          </section>
          <section className="panel glass">
            <h2>Time and quiet hours</h2>
            <label className="field"><span>Workspace time zone</span><select name="timezone" defaultValue={w.timezone}>{["Asia/Karachi", "Asia/Dubai", "Europe/London", "UTC", "America/New_York"].map((z) => <option key={z}>{z}</option>)}</select><small className="sub">Used for “today”, “yesterday” and daily counts.</small></label>
            <div className="set-row"><div>Quiet hours<small>No external messages in this window. In-app alerts still appear.</small></div><label className="sw"><input type="checkbox" name="quietEnabled" defaultChecked={s.quiet.enabled} /><i></i></label></div>
            <div className="grid2" style={{ gap: 10 }}>
              <label className="field"><span>From</span><input type="time" name="quietStart" defaultValue={s.quiet.start} /></label>
              <label className="field"><span>Until</span><input type="time" name="quietEnd" defaultValue={s.quiet.end} /></label>
            </div>
          </section>
          {admin && <div><Submit>Save settings</Submit></div>}
        </fieldset>
      </ActionForm>

      <section className="panel glass">
        <h2>How leads open</h2>
        <p className="sub">Your own choice, remembered in this browser. The pop-up lets you update a lead without leaving the list.</p>
        <LeadViewToggle />
      </section>

      <section className="panel glass">
        <h2>Reminder delivery</h2>
        <dl className="kv" style={{ gridTemplateColumns: "190px 1fr" }}>
          <dt>In-app alerts</dt><dd><span className="pill ok">Active</span> Created by the background pass and shown under Alerts.</dd>
          <dt>External channel</dt><dd>{ext.length ? <span className="pill ok">Webhook configured</span> : <span className="pill mute">Not configured</span>} {ext.length ? "Queued messages are POSTed to your webhook with retries." : "Set WEBHOOK_URL to send to WhatsApp, email or push through your own service."}</dd>
          <dt>Last background pass</dt><dd>{lastSweep ? new Date(lastSweep).toLocaleString([], { timeZone: c.tz }) : "Never"}</dd>
          <dt>Worker endpoint</dt><dd><code>POST /api/worker/tick</code> with <code>Authorization: Bearer CRON_SECRET</code>. Call it every minute from any scheduler for minute-level reminders.</dd>
        </dl>
        <p className="sub">Queues and overdue badges are computed from due times, so they are correct even when no worker has run. Only notifications and escalations wait for a pass.</p>
      </section>
    </>
  );
}
