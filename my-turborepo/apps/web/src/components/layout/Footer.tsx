import { Link } from "react-router";

import { MESSAGES } from "@/lib/messages";

export function Footer() {
  return (
    <footer className="flex h-10 w-full shrink-0 items-center justify-between gap-4 border-t border-hairline bg-background px-4 text-xs text-ink-faint sm:px-6">
      <span>
        © {new Date().getFullYear()} {MESSAGES.APP_NAME}
      </span>
      {/* Worth the line: a microphone-first product owes the person holding it
          a plain statement about where their voice goes. */}
      <span className="hidden md:inline">{MESSAGES.FOOTER_NOTE}</span>
      {/* Always visible, including at phone width, because a policy someone
          cannot find is a policy they were never shown. */}
      <nav aria-label={MESSAGES.LEGAL_NAV_LABEL} className="flex gap-4">
        <Link to="/privacy" className="hover:text-ink">
          {MESSAGES.LEGAL_PRIVACY}
        </Link>
        <Link to="/terms" className="hover:text-ink">
          {MESSAGES.LEGAL_TERMS}
        </Link>
      </nav>
    </footer>
  );
}
