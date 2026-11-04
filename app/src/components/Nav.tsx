"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Bell, Home, Sheet, Settings, Users, UserRound, Zap } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

const items = [
  { href: "/", label: "Overview", Icon: Home },
  { href: "/leads", label: "Leads", Icon: Users },
  { href: "/followups", label: "Follow-ups", Icon: Bell, soon: true },
  { href: "/team", label: "Team", Icon: UserRound, soon: true },
  { href: "/insights", label: "Insights", Icon: BarChart3, soon: true },
  { href: "/integrations", label: "Integrations", Icon: Sheet, soon: true },
  { href: "/settings", label: "Settings", Icon: Settings, soon: true },
];

function useActive() {
  const p = usePathname();
  return (href: string) => (href === "/" ? p === "/" : p.startsWith(href));
}

export function SideNav({ name, role }: { name: string; role: string }) {
  const on = useActive();
  const router = useRouter();
  return (
    <nav className="side glass" aria-label="Primary">
      <div className="brand"><span className="logo"><Zap size={18} /></span>LeadFlow</div>
      {items.map(({ href, label, Icon, soon }) => (
        <Link key={href} href={href} className={on(href) ? "on" : ""} aria-current={on(href) ? "page" : undefined}>
          <Icon size={18} />{label}{soon && <span className="pill" style={{ marginLeft: "auto" }}>Soon</span>}
        </Link>
      ))}
      <span className="spacer" />
      <div className="sub" style={{ padding: "0 10px" }}>{name} · {role}</div>
      <a href="#" onClick={async (e) => { e.preventDefault(); await authClient.signOut(); router.replace("/login"); router.refresh(); }}>Sign out</a>
    </nav>
  );
}

export function TabBar() {
  const on = useActive();
  return (
    <nav className="tabbar" aria-label="Primary mobile">
      {items.slice(0, 4).map(({ href, label, Icon }) => (
        <Link key={href} href={href} className={on(href) ? "on" : ""}><Icon size={20} />{label}</Link>
      ))}
      <Link href="/settings" className={on("/settings") ? "on" : ""}><Settings size={20} />Settings</Link>
    </nav>
  );
}
