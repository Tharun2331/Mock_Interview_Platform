import type { ReactNode } from "react";

import { BrandMark } from "@/components/BrandMark";
import { ThemeToggle } from "@/components/ThemeToggle";
import { MESSAGES } from "@/lib/messages";

// The identity surface. Sign-up, sign-in and confirmation are the portfolio
// impression, so unlike the screens behind the login they are allowed to be
// memorable — but they run on the same canvas, the same accent and the same
// signature bloom as the interview screen, because four screens that each look
// like a different product is the failure this layout exists to prevent.
//
// Two columns: the thesis on the left, the form on the right. Below the lg
// breakpoint the thesis collapses to the wordmark alone and the form takes the
// screen — someone signing in on a phone is trying to get in, not to read the
// pitch.

type AuthLayoutProps = { children: ReactNode };

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-background">
      {/* The bloom at rest, sized generously and sitting far behind the
          content. One hue, held still — a drifting field of colours would be a
          second signature competing with the first. */}
      <div
        className="orb-atmosphere pointer-events-none absolute -left-40 -top-40 size-[36rem] opacity-70"
        style={{ "--orb-hue": "var(--cue)" } as React.CSSProperties}
        aria-hidden
      />

      {/* The auth pages have no app chrome, so the theme control lives here.
          Someone who prefers light should not have to sign in on a dark page
          first to find the switch. */}
      <ThemeToggle className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6" />

      <div className="relative mx-auto grid min-h-screen w-full max-w-6xl grid-cols-1 gap-16 px-6 py-10 lg:grid-cols-2 lg:items-center lg:gap-20 lg:px-10">
        <section className="flex flex-col justify-center">
          <BrandMark size="lg" className="lg:mb-14" />

          {/* Hidden rather than reflowed on small screens. The pitch is real
              content, but it is not what someone opened this page to do. */}
          <div className="hidden lg:flex lg:flex-col">
            {/* Display sits at the face's own weight and never bolder. That
                restraint is the editorial voice; bolding it would swap the
                brand for consumer marketing. */}
            <h1 className="font-display text-6xl leading-[1.05] text-ink">
              {MESSAGES.APP_TAGLINE}
            </h1>
            <p className="mt-6 max-w-md text-base leading-relaxed text-ink-muted">
              {MESSAGES.APP_PITCH}
            </p>

            <ol className="mt-14 flex flex-col gap-7">
              {MESSAGES.APP_POINTS.map((point, index) => (
                <li key={point.title} className="flex gap-5">
                  {/* Numbering encodes a genuine sequence — attach, speak, read
                      back — rather than decorating an unordered list. */}
                  <span className="pt-0.5 font-mono text-xs text-cue-ink tabular-nums">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="flex flex-col gap-1 border-l border-hairline pl-5">
                    <span className="text-sm font-medium text-ink">
                      {point.title}
                    </span>
                    <span className="text-sm leading-relaxed text-ink-subtle">
                      {point.body}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="flex items-center justify-center lg:justify-end">
          <div className="w-full max-w-sm">{children}</div>
        </section>
      </div>
    </div>
  );
}
