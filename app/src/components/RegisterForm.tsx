"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

/** Used by /setup (owner bootstrap) and /accept (invitation). The secret travels in a header, never in the URL after load. */
export function RegisterForm({ kind, token, email, defaultName }: { kind: "setup" | "invite"; token?: string; email?: string; defaultName?: string }) {
  const router = useRouter();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const f = new FormData(e.currentTarget);
    const headers: Record<string, string> = kind === "setup" ? { "x-setup-token": String(f.get("token")) } : { "x-invite-token": token ?? "" };
    const res = await authClient.signUp.email({
      email: kind === "invite" ? email! : String(f.get("email")), password: String(f.get("password")), name: String(f.get("name")),
      fetchOptions: { headers },
    });
    setBusy(false);
    if (res.error) return setErr((res.error.message ?? "Could not create the account.") + (kind === "setup" ? " If you started setup before, sign in with that account and open /setup again to finish." : ""));
    router.replace("/"); router.refresh();
  }

  return (
    <form className="authcard glass" onSubmit={submit}>
      <h1 style={{ fontSize: 26 }}>{kind === "setup" ? "Set up LeadFlow" : "Join LeadFlow"}</h1>
      <label className="field"><span>Your name</span><input type="text" name="name" required defaultValue={defaultName} autoComplete="name" /></label>
      {kind === "setup"
        ? <label className="field"><span>Owner email</span><input type="text" inputMode="email" name="email" required autoComplete="email" /></label>
        : <label className="field"><span>Email</span><input type="text" value={email} readOnly /></label>}
      <label className="field"><span>Password (10+ characters)</span><input type="password" name="password" required minLength={10} autoComplete="new-password" /></label>
      {kind === "setup" && <label className="field"><span>Setup token</span><input type="password" name="token" required autoComplete="off" /></label>}
      {err && <p className="err" role="alert">{err}</p>}
      <button className="btn" disabled={busy}>{busy ? "Please wait" : kind === "setup" ? "Create admin account" : "Create account"}</button>
    </form>
  );
}
