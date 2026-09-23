import type { ComponentPropsWithoutRef, ReactNode } from "react";

import { cn } from "@/lib/utils";

// The small mono label that sits above a title, beside a field, or inside a
// chip. It existed sixteen times across seven files before this component did,
// and it had drifted into five different readings of the same idea: three
// tracking values (0.1em, 0.12em, 0.14em), three sizes (0.6rem, 0.65rem,
// 0.7rem) and one instance that had lost `font-mono` altogether. None of that
// was a decision — a label is not a different label because it sits on the
// coach page, and the drift is exactly what makes a set of screens read as
// assembled rather than designed.
//
// Two sizes, because two is what the content actually needs: `md` labels a
// section, `sm` labels a row inside one. The chip variant is the same label
// with a hairline around it, used where it carries a value rather than naming
// the thing below it.
type EyebrowProps = {
  children: ReactNode;
  // `h2`/`h3` where the label is genuinely the heading for the block under it,
  // so the document outline matches what a sighted reader sees. Defaults to
  // `span`, which is right for the majority that sit beside a real heading.
  as?: "span" | "p" | "h2" | "h3";
  size?: "sm" | "md";
  variant?: "plain" | "chip";
} & Omit<ComponentPropsWithoutRef<"span">, "children">;

export function Eyebrow({
  as: Tag = "span",
  size = "md",
  variant = "plain",
  className,
  children,
  ...rest
}: EyebrowProps) {
  return (
    <Tag
      className={cn(
        "font-mono uppercase text-ink-faint",
        size === "md"
          ? "text-[0.7rem] tracking-[0.14em]"
          : "text-[0.6rem] tracking-[0.12em]",
        // A bordered label reads as a value, so it needs the padding that a
        // bare one does not.
        variant === "chip" && "rounded border border-hairline px-1.5 py-0.5",
        // Last, so a caller overriding the colour — the interview clock turning
        // amber, a transcript row keyed to its speaker — wins over the default
        // through tailwind-merge rather than by accident of source order.
        className,
      )}
      {...rest}
    >
      {children}
    </Tag>
  );
}
