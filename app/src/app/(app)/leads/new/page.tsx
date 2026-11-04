import { listOwners } from "../actions";
import { NewLeadForm } from "./NewLeadForm";

export default async function NewLeadPage() {
  const owners = await listOwners();
  return (
    <>
      <header className="top"><div><h1>New lead</h1></div></header>
      <NewLeadForm owners={owners} />
    </>
  );
}
