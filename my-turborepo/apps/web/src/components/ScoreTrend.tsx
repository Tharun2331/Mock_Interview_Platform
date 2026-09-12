import { useId, useState } from "react";
import type { SessionHistoryItem } from "@repo/shared";

import { MESSAGES } from "@/lib/messages";

// Overall score across a candidate's interviews, oldest to newest.
//
// One series, so no legend: the heading names it. The line and its points carry
// a single accent rather than the score-band colours, for two reasons.
//
// First, colouring a point by its own value is colouring by rank, not by
// entity — on a single series that is the classic misuse of a status palette,
// and it makes a line that changes colour along its length for no structural
// reason.
//
// Second, the band colours do not survive the check. Run against the light
// surface, --score-weak and --score-mixed separate by ΔE 13.9 for NORMAL
// vision (below the floor of 15) and 3.2 under deuteranopia. They are legal
// where they appear today — the score cards pair every band with an icon and a
// text label — but a bare coloured dot would be colour-alone encoding of a pair
// that full-colour readers already struggle to tell apart.
//
// The band still reaches the reader: as text in the tooltip, and on the card
// for the same session directly below.

const WIDTH = 640;
const HEIGHT = 180;
const PADDING = { top: 16, right: 16, bottom: 28, left: 32 };

const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

// Fixed 0-10, never fitted to the data.
//
// Scores are bounded, so an auto-fitted axis would stretch a 6.1 → 6.3 wobble
// across the full height and read as a dramatic improvement. A fixed domain is
// what makes two charts — and two glances at the same chart — comparable.
const SCORE_MIN = 0;
const SCORE_MAX = 10;
const GRID_VALUES = [0, 5, 10];

function xFor(index: number, count: number): number {
  // A single point sits in the middle rather than at x=0, where it would look
  // like the start of a line that failed to draw.
  if (count <= 1) return PADDING.left + PLOT_WIDTH / 2;
  return PADDING.left + (index / (count - 1)) * PLOT_WIDTH;
}

function yFor(score: number): number {
  const clamped = Math.min(SCORE_MAX, Math.max(SCORE_MIN, score));
  const fraction = (clamped - SCORE_MIN) / (SCORE_MAX - SCORE_MIN);
  return PADDING.top + PLOT_HEIGHT - fraction * PLOT_HEIGHT;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  });
}

export function ScoreTrend({ sessions }: { sessions: SessionHistoryItem[] }) {
  const titleId = useId();
  const [hovered, setHovered] = useState<number | null>(null);

  // The API returns newest first, which is what the card list wants. A line
  // running right-to-left in time would read as improvement when it is decline.
  const points = [...sessions].reverse();

  // A trend needs two points to be a trend. Saying so beats drawing a lonely
  // dot and calling it a chart.
  if (points.length < 2) {
    return (
      <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-border p-6">
        <p className="max-w-sm text-center text-sm text-ink-subtle">
          {MESSAGES.HISTORY_TREND_NEEDS_MORE}
        </p>
      </div>
    );
  }

  const path = points
    .map((session, index) => {
      const command = index === 0 ? "M" : "L";
      return `${command}${xFor(index, points.length)} ${yFor(session.overallScore)}`;
    })
    .join(" ");

  const active = hovered === null ? undefined : points[hovered];

  // Generous, but never wider than the space between two points. At 16px flat
  // the targets start overlapping once a candidate has ~19 interviews, and a
  // hover then resolves to whichever circle happens to render last rather than
  // the one under the cursor.
  const spacing =
    points.length > 1 ? PLOT_WIDTH / (points.length - 1) : PLOT_WIDTH;
  const hitRadius = Math.max(6, Math.min(16, spacing / 2));

  return (
    <figure className="relative m-0 flex flex-col gap-2">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-labelledby={titleId}
      >
        {/* The whole series in one sentence, since a screen reader cannot read
            a path. The cards below carry every value individually. */}
        <title id={titleId}>
          {MESSAGES.HISTORY_TREND_ALT(
            points.length,
            points[0]?.overallScore ?? 0,
            points[points.length - 1]?.overallScore ?? 0
          )}
        </title>

        {/* Recessive: the grid orients, it does not compete with the data. */}
        {GRID_VALUES.map((value) => (
          <g key={value}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={yFor(value)}
              y2={yFor(value)}
              className="stroke-border"
              strokeWidth={1}
            />
            <text
              x={PADDING.left - 8}
              y={yFor(value)}
              textAnchor="end"
              dominantBaseline="middle"
              className="fill-ink-faint font-mono text-[10px] tabular-nums"
            >
              {value}
            </text>
          </g>
        ))}

        <path
          d={path}
          fill="none"
          stroke="var(--cue)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {points.map((session, index) => (
          <g key={session.sessionId}>
            {/* A hit target far larger than the mark, so a 4px dot does not
                demand pixel-accurate pointing. */}
            <circle
              cx={xFor(index, points.length)}
              cy={yFor(session.overallScore)}
              r={hitRadius}
              fill="transparent"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            />
            <circle
              cx={xFor(index, points.length)}
              cy={yFor(session.overallScore)}
              r={hovered === index ? 6 : 4}
              fill="var(--cue)"
              // A surface-coloured ring keeps two near-coincident points from
              // reading as one blob.
              stroke="var(--surface-1)"
              strokeWidth={2}
            />
          </g>
        ))}

        {/* First and last only. A date under every point collides the moment a
            candidate has more than a handful of interviews. */}
        <text
          x={PADDING.left}
          y={HEIGHT - 8}
          textAnchor="start"
          className="fill-ink-faint font-mono text-[10px]"
        >
          {formatDate(points[0]?.completedAt ?? "")}
        </text>
        <text
          x={WIDTH - PADDING.right}
          y={HEIGHT - 8}
          textAnchor="end"
          className="fill-ink-faint font-mono text-[10px]"
        >
          {formatDate(points[points.length - 1]?.completedAt ?? "")}
        </text>
      </svg>

      {/* Reserved height rather than conditional, so hovering does not shift
          the cards below. */}
      <figcaption className="min-h-[1.25rem] text-center text-xs text-ink-subtle">
        {active === undefined
          ? MESSAGES.HISTORY_TREND_CAPTION
          : MESSAGES.HISTORY_TREND_POINT(
              formatDate(active.completedAt),
              active.overallScore,
              active.role
            )}
      </figcaption>
    </figure>
  );
}
