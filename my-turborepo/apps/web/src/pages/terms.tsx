import { LegalDocument } from "@/components/LegalDocument";
import { TERMS_OF_SERVICE } from "@/lib/legal";

export function Terms() {
  return <LegalDocument doc={TERMS_OF_SERVICE} />;
}
