import { LeadView } from "@/components/LeadView";
import { LeadModal } from "@/components/LeadModal";
import { HardNavigate } from "@/components/HardNavigate";

export const dynamic = "force-dynamic";

export default async function LeadPopup({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Pages such as /leads/new share this URL shape. Anything that is not a lead id loads as an ordinary page.
  if (!/^[0-9a-f-]{36}$/i.test(id)) return <HardNavigate to={`/leads/${encodeURIComponent(id)}`} />;
  return <LeadModal id={id}><LeadView id={id} modal /></LeadModal>;
}
