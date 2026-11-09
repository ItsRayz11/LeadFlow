"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Bell, BellRing, BarChart3, Home, Sheet, Settings, Users, UserRound, Zap } from "lucide-react";
import { authClient } from "@/lib/auth-client";

type Item = { href: string; label: string; Icon: typeof Home; soon?: boolean; manager?: boolean; badge?: "overdue" | "unread" };
const items: Item[] = [
  { href: "/", label: "Overview", Icon: Home },
  { href: "/leads", label: "Leads", Icon: Users },
  { href: "/followups", label: "Follow-ups", Icon: Bell, badge: "overdue" },
  { href: "/team", label: "Team", Icon: UserRound, manager: true },
  { href: "/notifications", label: "Alerts", Icon: BellRing, badge: "unread" },
  { href: "/insights", label: "Insights", Icon: BarChart3, soon: true },
  { href: "/integrations", label: "Integrations", Icon: Sheet, manager: true },
  { href: "/settings", label: "Settings", Icon: Settings, manager: true },
];

function useActive() {
  const p = usePathname();
  return (href: string) => (href === "/" ? p === "/" : p.startsWith(href));
}
type Counts = { overdue: number; unread: number };

export function SideNav({ name, role, isManager, counts }: { name: string; role: string; isManager: boolean; counts: Counts }) {
  const on = useActive();
  const router = useRouter();
  return (
    <nav className="side glass" aria-label="Primary">
      <div className="brand"><span className="logo"><Zap size={18} /></span>LeadFlow</div>
      {items.filter((i) => isManager || !i.manager).map(({ href, label, Icon, soon, badge }) =>
        soon ? (
          <span key={href} aria-disabled="true" style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 44, padding: "0 10px", color: "var(--muted)", opacity: 0.6 }}>
            <Icon size={18} />{label}<span className="pill" style={{ marginLeft: "auto" }}>Later</span>
          </span>
        ) : (
          <Link key={href} href={href} className={on(href) ? "on" : ""} aria-current={on(href) ? "page" : undefined}>
            <Icon size={18} />{label}
            {badge && counts[badge] > 0 && <span className={`pill ${badge === "overdue" ? "crit" : "acc"} num`} style={{ marginLeft: "auto" }}>{counts[badge]}</span>}
          </Link>
        ),
      )}
      <span className="spacer" />
      <div className="sub" style={{ padding: "0 10px" }}>{name} · {role}</div>
      <a href="#" onClick={async (e) => { e.preventDefault(); await authClient.signOut(); router.replace("/login"); router.refresh(); }}>Sign out</a>
    </nav>
  );
}

export function TabBar({ isManager, counts }: { isManager: boolean; counts: Counts }) {
  const on = useActive();
  const tabs = items.filter((i) => !i.soon && (isManager || !i.manager)).filter((i) => ["/", "/leads", "/followups", "/team", "/notifications"].includes(i.href) || (!isManager && i.href === "/notifications"));
  const show = tabs.slice(0, 5);
  return (
    <nav className="tabbar" aria-label="Primary mobile" style={{ gridTemplateColumns: `repeat(${show.length}, 1fr)` }}>
      {show.map(({ href, label, Icon, badge }) => (
        <Link key={href} href={href} className={on(href) ? "on" : ""} aria-current={on(href) ? "page" : undefined}>
          <Icon size={20} />{label}
          {badge && counts[badge] > 0 && <span className="badge num">{counts[badge]}</span>}
        </Link>
      ))}
    </nav>
  );
}

export function SignOutButton() {
  const router = useRouter();
  return (
    <button type="button" className="chip" onClick={async () => { await authClient.signOut(); router.replace("/login"); router.refresh(); }}>Sign out</button>
  );
}
