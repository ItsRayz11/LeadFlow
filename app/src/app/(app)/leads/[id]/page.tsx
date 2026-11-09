import { LeadView } from "@/components/LeadView";

export const dynamic = "force-dynamic";

export default async function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  return <LeadView id={(await params).id} />;
}
