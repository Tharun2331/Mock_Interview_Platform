import { MESSAGES } from "@/lib/messages";

export function Footer() {
  return (
    <footer className="flex h-10 w-full shrink-0 items-center justify-center border-t bg-background px-4 text-xs text-muted-foreground">
      © {new Date().getFullYear()} {MESSAGES.APP_NAME}
    </footer>
  );
}
