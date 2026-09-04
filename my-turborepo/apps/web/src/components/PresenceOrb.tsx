import { cn } from "@/lib/utils";

// The product's signature element: a soft bloom standing in for the presence of
// the interviewer.
//
// Two rules make it a state reading rather than an ornament. Its hue is passed
// in from an interview-state token, so it always agrees with the status line
// beside it. And its scale comes from measured amplitude off the analyser, not
// from a state flag — an orb that swelled because the app believed it was
// recording would keep swelling while the microphone was muted at OS level,
// which is worse than no indicator because it actively lies.

type PresenceOrbProps = {
  // A CSS colour, expected to be one of the --state-* tokens.
  hue: string;
  // Measured amplitude, 0–1. Ignored unless `responsive` is set.
  level?: number;
  // True only while the candidate's own voice is driving the orb.
  responsive?: boolean;
  className?: string;
};

export function PresenceOrb({
  hue,
  level = 0,
  responsive = false,
  className,
}: PresenceOrbProps) {
  // Capped well short of the container so a shout cannot push the bloom out of
  // its own layout box.
  const scale = responsive ? 1 + Math.min(level, 1) * 0.28 : 1;

  return (
    <div
      className={cn("relative grid place-items-center", className)}
      // Decoration on top of the status line and the live region, both of which
      // carry the same information in words.
      aria-hidden
    >
      {/* The outer bloom. Blurred and low-opacity so it reads as light in the
          room rather than a second solid shape. */}
      <div
        className="presence-orb absolute inset-0 rounded-full opacity-40 blur-2xl transition-transform duration-100 motion-reduce:transition-none"
        style={{ "--orb-hue": hue, transform: `scale(${scale * 1.15})` } as React.CSSProperties}
      />
      {/* The core. Smaller, denser, and the thing the eye actually tracks. */}
      <div
        className="presence-orb relative size-2/3 rounded-full transition-transform duration-100 motion-reduce:transition-none"
        style={{ "--orb-hue": hue, transform: `scale(${scale})` } as React.CSSProperties}
      />
      {/* A hairline ring holds the shape when reduced motion freezes the scale,
          so the orb still reads as an object rather than a smudge. */}
      <div
        className="absolute inset-[12%] rounded-full border"
        style={{ borderColor: `color-mix(in oklab, ${hue} 35%, transparent)` }}
      />
    </div>
  );
}
