import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  AlertTriangleIcon,
  ArrowRightIcon,
  RefreshCwIcon,
  TrendingUpIcon,
} from "lucide-react";
import type { ScoreDimension, SessionHistoryItem } from "@repo/shared";

import { PresenceOrb } from "@/components/PresenceOrb";
import { ScoreTrend } from "@/components/ScoreTrend";
import { Button } from "@/components/ui/button";
import { transportMessage } from "@/lib/httpErrors";
import { fetchSessionHistory } from "@/lib/historyApi";
import { MESSAGES } from "@/lib/messages";

// Every finished interview, from one call. The chart and the cards read the
// same array — nothing here fetches per session, and clicking a card is what
// pays for the detail.

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function dimensionLabel(dimension: ScoreDimension): string {
  return MESSAGES.DIMENSION_LABEL[dimension];
}

function SessionCard({ session }: { session: SessionHistoryItem }) {
  return (
    <Link
      to={`/results/${session.sessionId}`}
      className="group flex flex-col gap-4 rounded-lg border border-border p-5 transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cue"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-base text-ink">
            {session.role ?? MESSAGES.HISTORY_TITLE}
          </span>
          <span className="font-mono text-xs text-ink-faint">
            {formatDate(session.completedAt)} ·{" "}
            {MESSAGES.HISTORY_QUESTIONS(session.questionCount)}
          </span>
        </div>

        {/* Tabular numerals so a column of scores stays aligned down the list. */}
        <div className="flex items-baseline gap-1">
          <span className="font-mono text-2xl tabular-nums text-ink">
            {session.overallScore}
          </span>
          <span className="text-xs text-ink-faint">/ 10</span>
        </div>
      </div>

      {/* Named dimensions rather than coloured chips. The band palette does not
          separate well enough at the light surface to carry meaning alone, and
          a word is unambiguous at any contrast. */}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs">
        <span className="text-ink-subtle">
          {MESSAGES.HISTORY_STRENGTH}:{" "}
          <span className="text-ink">{dimensionLabel(session.topStrength)}</span>
        </span>
        <span className="text-ink-subtle">
          {MESSAGES.HISTORY_WEAKNESS}:{" "}
          <span className="text-ink">{dimensionLabel(session.topWeakness)}</span>
        </span>
      </div>

      <span className="inline-flex items-center gap-1.5 text-xs text-cue-ink group-hover:underline">
        {MESSAGES.HISTORY_VIEW}
        <ArrowRightIcon aria-hidden className="size-3.5" />
      </span>
    </Link>
  );
}

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; sessions: SessionHistoryItem[] };

// Named SessionHistory rather than History: the DOM has a global `History`
// interface, and TypeScript resolves the global over a local import, which
// fails as "History cannot be used as a JSX component".
export function SessionHistory() {
  const navigate = useNavigate();
  const [page, setPage] = useState<PageState>({ status: "loading" });

  const load = useCallback(async (): Promise<void> => {
    try {
      const sessions = await fetchSessionHistory();
      setPage({ status: "ready", sessions });
    } catch (error) {
      setPage({
        status: "error",
        message: transportMessage(error, MESSAGES.HISTORY_LOAD_FAILED),
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
          {MESSAGES.HISTORY_LOAD_FAILED}
        </h2>
        {page.message !== MESSAGES.HISTORY_LOAD_FAILED ? (
          <p className="max-w-md text-sm leading-relaxed text-ink-muted">
            {page.message}
          </p>
        ) : null}
        <Button variant="outline" className="cursor-pointer" onClick={() => void load()}>
          <RefreshCwIcon aria-hidden className="size-4" />
          {MESSAGES.RETRY}
        </Button>
      </div>
    );
  }

  const { sessions } = page;

  // The most common first-run screen, so it is written as an invitation rather
  // than an apology for empty data.
  if (sessions.length === 0) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-5 p-6 text-center">
        <TrendingUpIcon aria-hidden className="size-6 text-ink-faint" />
        <h2 className="font-display text-2xl text-ink">
          {MESSAGES.HISTORY_EMPTY_TITLE}
        </h2>
        <p className="max-w-md text-sm leading-relaxed text-ink-muted">
          {MESSAGES.HISTORY_EMPTY_BODY}
        </p>
        <Button className="cursor-pointer" onClick={() => void navigate("/start")}>
          {MESSAGES.HISTORY_EMPTY_ACTION}
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 pb-16">
      <header className="flex flex-col gap-2">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
          {MESSAGES.HISTORY_TITLE}
        </span>
        <h2 className="font-display text-3xl text-ink">
          {MESSAGES.HISTORY_SUBTITLE(sessions.length)}
        </h2>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-5">
        <span className="text-xs uppercase tracking-wide text-ink-faint">
          {MESSAGES.HISTORY_TREND_TITLE}
        </span>
        <ScoreTrend sessions={sessions} />
      </section>

      {/* Also the chart's table view: every point above has a card here with its
          date, role and score in text. */}
      <section className="flex flex-col gap-3">
        {sessions.map((session) => (
          <SessionCard key={session.sessionId} session={session} />
        ))}
      </section>
    </div>
  );
}
