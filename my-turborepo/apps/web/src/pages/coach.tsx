import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertTriangleIcon,
  MinusIcon,
  RefreshCwIcon,
  SparklesIcon,
  TrendingDownIcon,
  TrendingUpIcon,
} from "lucide-react";
import type { CoachReport, ScoreDimension, Trend } from "@repo/shared";

import { PresenceOrb } from "@/components/PresenceOrb";
import { TrendSparkline } from "@/components/TrendSparkline";
import { Button } from "@/components/ui/button";
import { fetchCoachReport } from "@/lib/coachApi";
import { transportMessage } from "@/lib/httpErrors";
import { MESSAGES } from "@/lib/messages";

// What to practise next, drawn from every interview a candidate has finished.
//
// An app surface, not an identity one: the job is legibility of a system state
// the candidate cannot see any other way. The one place it does identity work
// is the empty screen, which is a first-run experience and written as an
// invitation rather than an apology.
//
// Four states, and three of them are reached by real people rather than being
// edge cases: loading, failed, nothing-to-coach, and a report. A fifth lives
// inside the report — one finished interview produces a roadmap and no trends,
// which is said in words rather than drawn as a lonely dot.

type Page =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; report: CoachReport };

// Colour is never the only channel: each direction carries an icon and its own
// word as well. The bands are also the only place score colours appear on this
// page, and they appear attached to text.
const DIRECTION: Record<
  Trend["direction"],
  { icon: typeof TrendingUpIcon; label: string; className: string }
> = {
  improving: {
    icon: TrendingUpIcon,
    label: MESSAGES.COACH_DIRECTION_IMPROVING,
    className: "text-score-strong",
  },
  declining: {
    icon: TrendingDownIcon,
    label: MESSAGES.COACH_DIRECTION_DECLINING,
    className: "text-score-weak",
  },
  flat: {
    icon: MinusIcon,
    label: MESSAGES.COACH_DIRECTION_FLAT,
    className: "text-score-mixed",
  },
};

function DirectionChip({ direction }: { direction: Trend["direction"] }) {
  const { icon: Icon, label, className } = DIRECTION[direction];

  return (
    <span className={`flex items-center gap-1.5 text-xs font-medium ${className}`}>
      <Icon aria-hidden className="size-3.5 shrink-0" />
      {label}
    </span>
  );
}

function WeakDimension({ dimension }: { dimension: ScoreDimension }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-faint">
        {MESSAGES.COACH_WEAKEST}
      </span>
      <span className="text-sm text-ink">
        {MESSAGES.COACH_DIMENSION_LABEL[dimension]}
      </span>
      {/* The anchor. "Weakest: depth" on its own teaches nothing — this is the
          sentence that makes the focus points below read as a consequence. */}
      <span className="text-xs leading-relaxed text-ink-subtle">
        {MESSAGES.COACH_DIMENSION_ANCHOR[dimension]}
      </span>
    </div>
  );
}

export function Coach() {
  const navigate = useNavigate();
  const [page, setPage] = useState<Page>({ status: "loading" });

  const load = useCallback(async () => {
    setPage({ status: "loading" });
    try {
      setPage({ status: "ready", report: await fetchCoachReport() });
    } catch (error) {
      setPage({
        status: "error",
        message: transportMessage(error, MESSAGES.COACH_LOAD_FAILED),
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (page.status === "loading") {
    return (
      <div className="flex min-h-full w-full flex-col items-center justify-center gap-5 py-20">
        <PresenceOrb
          hue="var(--cue)"
          className="size-12 animate-pulse motion-reduce:animate-none"
        />
        <p className="text-sm text-ink-subtle">{MESSAGES.LOADING}</p>
      </div>
    );
  }

  if (page.status === "error") {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-5 p-6 text-center">
        <AlertTriangleIcon aria-hidden className="size-5 text-ink-subtle" />
        <h2 className="font-display text-2xl text-ink">
          {MESSAGES.COACH_LOAD_FAILED}
        </h2>
        {page.message !== MESSAGES.COACH_LOAD_FAILED ? (
          <p className="max-w-md text-sm leading-relaxed text-ink-muted">
            {page.message}
          </p>
        ) : null}
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={() => void load()}
        >
          <RefreshCwIcon aria-hidden className="size-4" />
          {MESSAGES.RETRY}
        </Button>
      </div>
    );
  }

  const { trends, roadmap } = page.report;

  // The most common first-run screen. An invitation, not an apology for empty
  // data — a candidate who has finished nothing has done nothing wrong.
  if (roadmap.length === 0) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-5 p-6 text-center">
        <SparklesIcon aria-hidden className="size-6 text-ink-faint" />
        <h2 className="font-display text-2xl text-ink">
          {MESSAGES.COACH_EMPTY_TITLE}
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-ink-muted">
          {MESSAGES.COACH_EMPTY_BODY}
        </p>
        <Button className="cursor-pointer" onClick={() => void navigate("/start")}>
          {MESSAGES.COACH_EMPTY_ACTION}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 pb-16">
      <header className="flex flex-col gap-2">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
          {MESSAGES.COACH_TITLE}
        </span>
        <h2 className="font-display text-3xl text-ink">
          {MESSAGES.COACH_SUBTITLE}
        </h2>
        <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
          {MESSAGES.COACH_INTRO}
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <span className="text-xs uppercase tracking-wide text-ink-faint">
          {MESSAGES.COACH_TRENDS_TITLE}
        </span>

        {/* A roadmap with no trends means every topic has exactly one
            interview. Said plainly and as a next step, rather than rendering
            an empty section the reader has to interpret. */}
        {trends.length === 0 ? (
          <div className="flex min-h-[80px] items-center justify-center rounded-lg border border-border p-6">
            <p className="max-w-sm text-center text-sm leading-relaxed text-ink-subtle">
              {MESSAGES.COACH_TRENDS_NEEDS_MORE}
            </p>
          </div>
        ) : (
          trends.map((trend) => (
            <article
              key={trend.topic}
              className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="flex flex-col gap-1">
                  <h3 className="text-sm font-medium text-ink">{trend.topic}</h3>
                  <div className="flex items-center gap-3">
                    <DirectionChip direction={trend.direction} />
                    <span className="font-mono text-xs tabular-nums text-ink-faint">
                      {MESSAGES.COACH_ROUNDS(trend.scoreHistory.length)}
                    </span>
                  </div>
                </div>
                <TrendSparkline topic={trend.topic} points={trend.scoreHistory} />
              </div>
              <p className="text-sm leading-relaxed text-ink-muted">
                {trend.summary}
              </p>
            </article>
          ))
        )}
      </section>

      <section className="flex flex-col gap-4">
        <span className="text-xs uppercase tracking-wide text-ink-faint">
          {MESSAGES.COACH_ROADMAP_TITLE}
        </span>

        {/* An ordered list because the order is the content — priority 1 is
            where to start. A screen reader gets that from <ol> without the
            number having to be read as decoration. */}
        <ol className="flex flex-col gap-4">
          {roadmap.map((item) => (
            <li
              key={item.topic}
              className="flex flex-col gap-4 rounded-lg border border-border bg-surface-2 p-5"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
                <div className="flex items-start gap-3">
                  {/* Tabular numerals so a column of priorities lines up. */}
                  <span
                    aria-hidden
                    className="mt-0.5 font-mono text-sm tabular-nums text-ink-faint"
                  >
                    {String(item.priority).padStart(2, "0")}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <h3 className="text-sm font-medium text-ink">{item.topic}</h3>
                    <span className="text-xs text-ink-subtle">
                      {MESSAGES.COACH_ROADMAP_AVERAGE}{" "}
                      <span className="font-mono tabular-nums text-ink-muted">
                        {item.avgScore.toFixed(1)}
                      </span>
                    </span>
                  </div>
                </div>
                <WeakDimension dimension={item.weakDimension} />
              </div>

              {item.focusPoints.length > 0 ? (
                <ul className="flex flex-col gap-2 border-l border-hairline pl-4">
                  {item.focusPoints.map((point) => (
                    <li key={point} className="text-sm leading-relaxed text-ink">
                      {point}
                    </li>
                  ))}
                </ul>
              ) : (
                // The advice failed to generate. Saying so beats an empty gap
                // the reader assumes is a loading state that never resolved.
                <p className="text-xs leading-relaxed text-ink-subtle">
                  {MESSAGES.COACH_NO_FOCUS_POINTS}
                </p>
              )}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
