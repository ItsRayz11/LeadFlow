/** Normalizes a phone number for duplicate detection. The original text is stored separately and never altered. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00")) d = d.slice(2);
  // Pakistan: 0300... -> 92300...
  if (d.length === 11 && d.startsWith("0")) d = "92" + d.slice(1);
  return d.length >= 7 ? d : null;
}
