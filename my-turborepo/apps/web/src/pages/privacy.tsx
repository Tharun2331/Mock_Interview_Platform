import { LegalDocument } from "@/components/LegalDocument";
import { PRIVACY_POLICY } from "@/lib/legal";

export function Privacy() {
  return <LegalDocument doc={PRIVACY_POLICY} />;
}
