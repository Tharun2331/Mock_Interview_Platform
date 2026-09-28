import { useId, useState } from "react";
import type { MetricSeries } from "@repo/shared";

import { Eyebrow } from "@/components/Eyebrow";
import {
  MESSAGES,
  adminFormatCount,
  adminFormatMs,
  adminMetricAlt,
} from "@/lib/messages";

// One metric over time.
//
// Hand-rolled SVG, matching ScoreTrend and TrendSparkline rather than pulling in a
// charting library — the project has an established idiom for this and one chart
// is not a reason to add a dependency and a second visual language.
//
// **The one deliberate departure from ScoreTrend: the y-domain is fitted, not
// fixed.** That component pins 0–10 and explains at length why an auto-fitted
// axis would be wrong there — scores are bounded, so fitting would stretch a
// 6.1 → 6.3 wobble across the full height and read as a transformation. Every
// reason for that is absent here and the opposite applies: latency, token counts
// and request counts have no upper bound and no meaningful scale in common. A
// fixed domain would need a ceiling nobody can choose, and would flatten every
// series that lives well below it into a line along the floor.
//
// What fitting costs, and how it is paid for: a fitted axis makes noise look like
// signal, because any variation fills the height. So the axis is always LABELLED
// with its real maximum and always starts at zero — a fitted axis with a
// non-zero baseline is the actual lie, since it makes a 2% change look like a
// doubling. Zero-anchored plus a stated maximum means the reader can see the
// magnitude, not just the shape.

const WIDTH = 520;
const HEIGHT = 140;
const PADDING = { top: 12, right: 12, bottom: 22, left: 52 };

const PLOT_WIDTH = WIDTH - PADDING.left - PADDING.right;
const PLOT_HEIGHT = HEIGHT - PADDING.top - PADDING.bottom;

function formatValue(value: number, unit: MetricSeries["unit"]): string {
  return unit === "Milliseconds"
    ? adminFormatMs(value)
    : adminFormatCount(value);
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MetricChart({ series }: { series: MetricSeries }) {
  const titleId = useId();
  const [hovered, setHovered] = useState<number | null>(null);

  // Empty is a first-class state, not a degenerate chart.
  //
  // This is the common case right now — nothing ingests EMF until the service runs
  // on ECS — and it means something different from "the value was zero". A flat
  // line at zero would be a claim about the service that nothing here can support.
  if (series.empty || series.values.length === 0) {
    return (
      <figure className="m-0 flex flex-col gap-2">
        <Eyebrow as="h3" size="sm">
          {series.label}
        </Eyebrow>
        <div className="flex min-h-[80px] items-center justify-center rounded-lg border border-border bg-surface-2 p-4">
          <p className="text-xs text-ink-faint">
            {MESSAGES.ADMIN_METRICS_SERIES_EMPTY}
          </p>
        </div>
      </figure>
    );
  }

  const values = series.values;

  // The DATA's extremes, and the DOMAIN's ceiling, kept separate.
  //
  // They differ in exactly one case and it is a common one: an all-zero series —
  // which is what a healthy 5xx count looks like — needs a non-zero domain, because
  // a 0–0 range divides by zero in `yFor` and lands every point at NaN, rendering
  // an invisible chart rather than an error.
  //
  // Conflating the two was a real bug, caught by reading the accessibility tree in
  // a browser: with one `max` doing both jobs, the alt text for an all-zero series
  // announced "highest 1" — a maximum that is not in the data, to the one reader
  // who cannot see the flat line at the floor and check. The axis may legitimately
  // be labelled 1 (a scale has to go somewhere); the description of the data may
  // not.
  const dataMax = Math.max(...values);
  const dataMin = Math.min(...values);
  const domainMax = dataMax || 1;

  const xFor = (index: number): number => {
    if (values.length <= 1) return PADDING.left + PLOT_WIDTH / 2;
    return PADDING.left + (index / (values.length - 1)) * PLOT_WIDTH;
  };

  const yFor = (value: number): number =>
    PADDING.top + PLOT_HEIGHT - (value / domainMax) * PLOT_HEIGHT;

  const path = values
    .map(
      (value, index) =>
        `${index === 0 ? "M" : "L"}${xFor(index)} ${yFor(value)}`,
    )
    .join(" ");

  const active = hovered === null ? undefined : hovered;

  // Bounded the same way ScoreTrend bounds its hit targets: generous enough that a
  // 2px line does not demand pixel-accurate pointing, never wider than the gap
  // between two points — past which a hover resolves to whichever rect rendered
  // last rather than the one under the cursor.
  const spacing =
    values.length > 1 ? PLOT_WIDTH / (values.length - 1) : PLOT_WIDTH;
  const hitWidth = Math.max(4, Math.min(24, spacing));

  const latest = values[values.length - 1] ?? 0;

  return (
    <figure className="m-0 flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <Eyebrow as="h3" size="sm">
          {series.label}
        </Eyebrow>
        {/* The latest value in text, always. The chart carries the shape; a
            number a reader can quote carries the state, and it is what makes this
            legible without hovering — or at all, for a keyboard or screen-reader
            user who has no hover to offer. */}
        <span className="font-mono text-sm tabular-nums text-ink">
          {formatValue(latest, series.unit)}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full"
        role="img"
        aria-labelledby={titleId}
      >
        <title id={titleId}>
          {/* The data's own extremes, never the domain ceiling — see dataMax. */}
          {adminMetricAlt(
            series.label,
            values.length,
            Math.round(dataMin),
            Math.round(dataMax),
            Math.round(latest),
          )}
        </title>

        {/* Zero and the maximum only. A denser grid at 140px tall competes with a
            line that is the entire point, and these two are the pair that makes a
            fitted axis honest — the reader can see both what the floor is and what
            the ceiling actually equals. */}
        {[0, domainMax].map((value) => (
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
              className="fill-ink-faint font-mono text-[9px] tabular-nums"
            >
              {formatValue(value, series.unit)}
            </text>
          </g>
        ))}

        {/* Filled to the baseline as well as stroked. On a zero-anchored axis the
            area is meaningful — it is magnitude — and at this height it is what
            separates "flat near zero" from "flat near the top" at a glance. Kept
            very low opacity so several of these stacked down a page do not read as
            a block of colour. */}
        <path
          d={`${path} L${xFor(values.length - 1)} ${yFor(0)} L${xFor(0)} ${yFor(0)} Z`}
          fill="var(--cue)"
          opacity={0.12}
        />

        <path
          d={path}
          fill="none"
          // One accent, never coloured by value. Colouring a single series by its
          // own magnitude is colouring by rank rather than by entity — the same
          // reasoning ScoreTrend records for not using the score bands, and the
          // same reason "is this number bad" is answered by the alarm thresholds
          // in Terraform rather than by a hue here.
          stroke="var(--cue)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {values.map((value, index) => (
          <g key={series.timestamps[index] ?? index}>
            <rect
              x={xFor(index) - hitWidth / 2}
              y={PADDING.top}
              width={hitWidth}
              height={PLOT_HEIGHT}
              fill="transparent"
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(null)}
            />
            {/* A mark per point only while hovered. At up to 170 points a dot
                each turns the line into a bead chain and hides the shape it
                exists to show. */}
            {hovered === index ? (
              <circle
                cx={xFor(index)}
                cy={yFor(value)}
                r={4}
                fill="var(--cue)"
                stroke="var(--surface-1)"
                strokeWidth={2}
              />
            ) : null}
          </g>
        ))}

        {/* First and last only, matching ScoreTrend. A label per point collides
            immediately at this width. */}
        <text
          x={PADDING.left}
          y={HEIGHT - 6}
          textAnchor="start"
          className="fill-ink-faint font-mono text-[9px]"
        >
          {formatTime(series.timestamps[0] ?? "")}
        </text>
        <text
          x={WIDTH - PADDING.right}
          y={HEIGHT - 6}
          textAnchor="end"
          className="fill-ink-faint font-mono text-[9px]"
        >
          {formatTime(series.timestamps[series.timestamps.length - 1] ?? "")}
        </text>
      </svg>

      {/* Reserved height rather than conditional, so hovering across a column of
          charts does not shift every one below it. */}
      <figcaption className="min-h-[1rem] text-center text-[11px] text-ink-subtle">
        {active === undefined
          ? null
          : `${formatTime(series.timestamps[active] ?? "")} · ${formatValue(
              values[active] ?? 0,
              series.unit,
            )}`}
      </figcaption>
    </figure>
  );
}
