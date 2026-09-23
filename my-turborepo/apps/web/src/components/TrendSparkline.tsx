import { useId } from "react";
import type { TrendPoint } from "@repo/shared";

import { MESSAGES } from "@/lib/messages";

// A topic's score line, sized to sit inside a card.
//
// NOT a smaller ScoreTrend, and deliberately not a refactor of it. That chart
// is one series with axes, gridlines, hover targets and a caption, and it is
// the only thing on the history page. This one appears up to six times on a
// page whose subject is the advice beside it — six of those would be a wall of
// charts where the reader wants a wall of sentences. Different job, different
// component; they share only the fixed domain below, which is the part that
// actually has to agree.
//
// No hover, no tooltip, no axis labels. The direction is stated in words next
// to it and the roadmap carries the numbers, so this is a shape rather than a
// data table — everything it could tell you on hover is already on the card.

const WIDTH = 168;
const HEIGHT = 40;
const PADDING = 5;

// Fixed 0-10, never fitted to the data. Two reasons, and the second is the one
// that matters here: an auto-fitted axis would stretch a 6.1 → 6.3 wobble
// across the full height and read as a transformation, and — because these
// render side by side — two topics with different ranges would draw the same
// line at different scales. A reader comparing two cards has to be comparing
// the same axis.
const SCORE_MIN = 0;
const SCORE_MAX = 10;

function xFor(index: number, count: number): number {
  if (count <= 1) return WIDTH / 2;
  return PADDING + (index / (count - 1)) * (WIDTH - PADDING * 2);
}

function yFor(score: number): number {
  const clamped = Math.min(SCORE_MAX, Math.max(SCORE_MIN, score));
  const fraction = (clamped - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);
  return PADDING + (HEIGHT - PADDING * 2) * (1 - fraction);
}

export function TrendSparkline({
  topic,
  points,
}: {
  topic: string;
  points: TrendPoint[];
}) {
  const titleId = useId();

  // The schema guarantees two, so this is a type guard rather than a state.
  // Rendering nothing beats rendering a lonely dot and calling it a line.
  if (points.length < 2) return null;

  const path = points
    .map((point, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${xFor(index, points.length)} ${yFor(point.avgScore)}`;
    })
    .join(" ");

  const last = points[points.length - 1];

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="h-10 w-full max-w-[168px] shrink-0"
      role="img"
      aria-labelledby={titleId}
    >
      {/* A screen reader cannot read a path, and this one has no hover to fall
          back on — so the whole series goes in the title. */}
      <title id={titleId}>
        {MESSAGES.COACH_TREND_ALT(
          topic,
          points.length,
          points[0]?.avgScore ?? 0,
          last?.avgScore ?? 0,
        )}
      </title>

      {/* The midpoint only. A full grid at this size is noise, but without any
          reference a rising line is unreadable as "rising to what". */}
      <line
        x1={PADDING}
        x2={WIDTH - PADDING}
        y1={yFor(5)}
        y2={yFor(5)}
        className="stroke-border"
        strokeWidth={1}
        strokeDasharray="2 3"
      />

      <path
        d={path}
        fill="none"
        // One accent for every topic rather than colouring by value. Colouring
        // a line by its own score is colouring by rank, not by entity, and the
        // score bands do not survive a contrast check as bare marks — they
        // reach the reader as the direction chip's text beside this instead.
        stroke="var(--cue)"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Only the latest point is marked. It is the one a candidate is looking
          for — where they are now — and a dot per interview turns a 168px line
          into a row of beads. */}
      <circle
        cx={xFor(points.length - 1, points.length)}
        cy={yFor(last?.avgScore ?? 0)}
        r={3}
        fill="var(--cue)"
        stroke="var(--surface-1)"
        strokeWidth={2}
      />
    </svg>
  );
}
