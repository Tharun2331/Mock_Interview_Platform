import { PresenceOrb } from "@/components/PresenceOrb";
import { MESSAGES } from "@/lib/messages";
import { cn } from "@/lib/utils";

// The wordmark is the signature element at rest: the same bloom the interview
// screen animates, held still in the accent. Stating the idea once as the brand
// mark and once as live state is what ties the marketing surface and the app
// surface into one product rather than two.

type BrandMarkProps = {
  className?: string;
  // Display-serif wordmark for identity surfaces; the app chrome uses the
  // smaller sans cut so the header stays chrome and not a title.
  size?: "sm" | "lg";
};

export function BrandMark({ className, size = "sm" }: BrandMarkProps) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <PresenceOrb
        hue="var(--cue)"
        className={size === "lg" ? "size-6" : "size-4"}
      />
      <span
        className={
          size === "lg"
            ? "font-display text-2xl text-ink"
            : "text-sm font-medium tracking-tight text-ink"
        }
      >
        {MESSAGES.APP_NAME}
      </span>
    </span>
  );
}
