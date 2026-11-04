"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr(""); setBusy(true);
    const f = new FormData(e.currentTarget);
    const res = await authClient.signIn.email({ email: String(f.get("email")), password: String(f.get("password")) });
    setBusy(false);
    if (res.error) return setErr("Email or password is incorrect.");
    router.replace("/"); router.refresh();
  }

  return (
    <div className="authwrap">
      <form className="authcard glass" onSubmit={submit}>
        <h1 style={{ fontSize: 26 }}>Sign in to LeadFlow</h1>
        <label className="field"><span>Email</span><input type="text" inputMode="email" name="email" required autoComplete="email" /></label>
        <label className="field"><span>Password</span><input type="password" name="password" required autoComplete="current-password" /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>{busy ? "Please wait" : "Sign in"}</button>
        <p className="sub">Accounts are created by invitation. Ask an admin for your link.</p>
      </form>
    </div>
  );
}
