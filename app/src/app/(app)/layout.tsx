import { redirect } from "next/navigation";
import { SideNav, TabBar } from "@/components/Nav";
import { getCtx } from "@/lib/session";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  if (!ctx) {
    const s = await auth.api.getSession({ headers: await headers() });
    if (!s) redirect("/login");
    return (
      <div className="authwrap"><div className="authcard glass">
        <h1 style={{ fontSize: 22 }}>Waiting for an invite</h1>
        <p>Your account ({s.user.email}) is not part of the workspace yet. Ask an admin to invite this email, then reload.</p>
      </div></div>
    );
  }
  return (
    <div className="shell">
      <SideNav name={ctx.name} role={ctx.role} />
      <main className="main">{children}</main>
      <TabBar />
    </div>
  );
}
