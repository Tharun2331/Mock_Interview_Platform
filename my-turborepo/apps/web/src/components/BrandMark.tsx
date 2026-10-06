import logo from "@/logo.svg";
import { MESSAGES } from "@/lib/messages";
import { cn } from "@/lib/utils";

// The logo mark beside the wordmark. The mark is the same file the favicon
// points at, so the browser tab and the header cannot drift apart.
//
// The wordmark stays in the ink token rather than the logo's indigo: indigo on
// the dark canvas falls short of text contrast, and the mark already carries
// the colour.

type BrandMarkProps = {
  className?: string;
  // Display-serif wordmark for identity surfaces; the app chrome uses the
  // smaller sans cut so the header stays chrome and not a title.
  size?: "sm" | "lg";
};

export function BrandMark({ className, size = "sm" }: BrandMarkProps) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      {/* Empty alt: the wordmark beside it already names the product, so a
          screen reader would otherwise hear it twice. */}
      <img
        src={logo}
        alt=""
        className={size === "lg" ? "size-8" : "size-6"}
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
