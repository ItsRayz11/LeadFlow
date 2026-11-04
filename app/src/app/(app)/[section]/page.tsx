import { notFound } from "next/navigation";

const NAMES: Record<string, string> = {
  followups: "Follow-ups", team: "Team", insights: "Insights", integrations: "Integrations", settings: "Settings",
};

export default async function Soon({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const name = NAMES[section];
  if (!name) notFound();
  return (
    <>
      <header className="top"><div><h1>{name}</h1></div></header>
      <section className="panel glass"><h2>Coming next</h2><p className="sub">This section is being built. The design preview shows how it will work.</p></section>
    </>
  );
}
