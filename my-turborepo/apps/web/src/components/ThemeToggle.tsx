import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { MoonIcon, SunIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { MESSAGES } from "@/lib/messages";
import { cn } from "@/lib/utils";

// Two states, not three. A system option would be the honest superset, but it
// makes the control's own icon ambiguous — a third "auto" glyph tells you what
// the setting is and not what the screen is doing. The default is still system;
// this only overrides it once someone expresses a preference.
export function ThemeToggle({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // resolvedTheme is undefined until next-themes has read the stored preference
  // and the system query on the client. Rendering the icon before then picks a
  // side at random and flips it a frame later.
  useEffect(() => setMounted(true), []);

  const isDark = resolvedTheme === "dark";

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn("cursor-pointer text-ink-subtle hover:text-ink", className)}
      // Names the destination, not the current state: a control labelled with
      // where you already are gives no reason to press it.
      aria-label={isDark ? MESSAGES.THEME_TO_LIGHT : MESSAGES.THEME_TO_DARK}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {/* Space is held from the first paint so the header does not reflow when
          the resolved theme arrives. */}
      {mounted ? (
        isDark ? (
          <SunIcon aria-hidden className="size-4" />
        ) : (
          <MoonIcon aria-hidden className="size-4" />
        )
      ) : (
        <span className="size-4" aria-hidden />
      )}
    </Button>
  );
}
