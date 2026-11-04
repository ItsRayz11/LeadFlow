"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    const f = new FormData(e.currentTarget);
    const email = String(f.get("email"));
    const password = String(f.get("password"));
    const res =
      mode === "in"
        ? await authClient.signIn.email({ email, password })
        : await authClient.signUp.email({ email, password, name: String(f.get("name")) });
    setBusy(false);
    if (res.error) return setErr(res.error.message ?? "Something went wrong. Try again.");
    router.replace("/");
    router.refresh();
  }

  return (
    <div className="authwrap">
      <form className="authcard glass" onSubmit={submit}>
        <h1 style={{ fontSize: 26 }}>{mode === "in" ? "Sign in to LeadFlow" : "Create your account"}</h1>
        {mode === "up" && (
          <label className="field"><span>Name</span><input type="text" name="name" required autoComplete="name" /></label>
        )}
        <label className="field"><span>Email</span><input type="text" inputMode="email" name="email" required autoComplete="email" /></label>
        <label className="field"><span>Password</span><input type="password" name="password" required minLength={8} autoComplete={mode === "in" ? "current-password" : "new-password"} style={{ minHeight: 44, width: "100%", padding: "8px 12px", borderRadius: 12, border: "1px solid var(--edge)", background: "var(--glass-strong)", color: "var(--fg)" }} /></label>
        {err && <p className="err" role="alert">{err}</p>}
        <button className="btn" disabled={busy}>{busy ? "Please wait" : mode === "in" ? "Sign in" : "Create account"}</button>
        <button type="button" className="btn ghost" onClick={() => { setMode(mode === "in" ? "up" : "in"); setErr(""); }}>
          {mode === "in" ? "First time or invited? Create account" : "I already have an account"}
        </button>
        <p className="sub">The first account becomes the admin. After that, sign-up works only for invited emails.</p>
      </form>
    </div>
  );
}
