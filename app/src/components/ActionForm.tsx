"use client";
import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import type { R } from "@/app/(app)/actions";

export function Submit({ children, className = "btn", pendingText = "Saving" }: { children: React.ReactNode; className?: string; pendingText?: string }) {
  const { pending } = useFormStatus();
  return <button className={className} disabled={pending} aria-busy={pending}>{pending ? pendingText : children}</button>;
}

/** A form wired to a server action, with an inline result message. `resetOnOk` clears inputs after success. */
export function ActionForm({
  action, children, className, resetOnOk = false, onOk,
}: {
  action: (prev: R, fd: FormData) => Promise<R>;
  children: React.ReactNode; className?: string; resetOnOk?: boolean; onOk?: () => void;
}) {
  const [state, run] = useActionState(action, undefined);
  const ref = useRef<HTMLFormElement>(null);
  const [reqId, setReqId] = useState(rid);
  const okRef = useRef(onOk);
  okRef.current = onOk;
  useEffect(() => {
    if (!state?.ok) return;
    if (resetOnOk) ref.current?.reset();
    setReqId(rid());
    okRef.current?.();
  }, [state, resetOnOk]);
  return (
    <form ref={ref} action={run} className={className}>
      <input type="hidden" name="requestId" value={reqId} />
      {children}
      {state?.error && <p className="err" role="alert">{state.error}</p>}
      {state?.ok && state.message && <p className="ok-msg" role="status">{state.message}</p>}
      {state?.ok && state.link && (
        <label className="field"><span>Invitation link (shown once)</span>
          <input type="text" readOnly value={state.link} onFocus={(e) => e.currentTarget.select()} aria-label="Invitation link" /></label>
      )}
    </form>
  );
}

export function rid() {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
}
