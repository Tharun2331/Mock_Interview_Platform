import { MESSAGES } from "@/lib/messages";

export function Footer() {
  return (
    <footer className="flex h-10 w-full shrink-0 items-center justify-between gap-4 border-t border-hairline bg-background px-4 text-xs text-ink-faint sm:px-6">
      <span>
        © {new Date().getFullYear()} {MESSAGES.APP_NAME}
      </span>
      {/* Worth the line: a microphone-first product owes the person holding it
          a plain statement about where their voice goes. */}
      <span className="hidden sm:inline">{MESSAGES.FOOTER_NOTE}</span>
    </footer>
  );
}
