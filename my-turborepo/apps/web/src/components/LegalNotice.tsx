import { Link } from "react-router";

import { MESSAGES } from "@/lib/messages";
import { cn } from "@/lib/utils";

// The agreement line on the sign-up and sign-in pages.
//
// A notice next to the button, not a checkbox. Courts uphold this pattern when
// the notice is visible without scrolling, sits beside the action that signals
// agreement, and links the actual terms, which is what this does. It also
// covers Google sign-up, which never reaches a form a checkbox could sit in.
//
// The links open in a new tab so a half-filled form is not lost by reading.

export function LegalNotice({ className }: { className?: string }) {
  const link = "text-ink-muted underline underline-offset-4 hover:text-ink";
  return (
    <p className={cn("text-xs leading-relaxed text-ink-faint", className)}>
      {MESSAGES.LEGAL_NOTICE_PREFIX}{" "}
      <Link to="/terms" target="_blank" rel="noopener" className={link}>
        {MESSAGES.LEGAL_NOTICE_TERMS}
      </Link>{" "}
      {MESSAGES.LEGAL_NOTICE_JOIN}{" "}
      <Link to="/privacy" target="_blank" rel="noopener" className={link}>
        {MESSAGES.LEGAL_NOTICE_PRIVACY}
      </Link>
      .
    </p>
  );
}
