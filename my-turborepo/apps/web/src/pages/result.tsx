import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  CircleDotIcon,
  MinusCircleIcon,
  RefreshCwIcon,
  ScissorsIcon,
} from "lucide-react";
import type { EvaluationResponse, EvaluationView } from "@repo/shared";

import { PresenceOrb } from "@/components/PresenceOrb";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { transportMessage } from "@/lib/httpErrors";
import { MESSAGES } from "@/lib/messages";
import { fetchEvaluation, isEvaluationFinished } from "@/lib/resultsApi";

// How often to ask again while answers are still being scored. A generous
// interval on purpose: a fifteen-question round takes seconds per answer, and
// the progress count already tells the candidate the system is working, so
// polling harder buys nothing and burns their rate-limit budget.
const POLL_INTERVAL_MS = 4000;

type ScoreBand = "strong" | "mixed" | "weak";

// Bands rather than a gradient. A number needs a meaning attached or it is
// trivia, and three named bands are what let the same score read the same way
// across every answer and every interview.
function bandFor(score: number): ScoreBand {
  if (score >= 7) return "strong";
  if (score >= 4) return "mixed";
  return "weak";
}

// Colour is never the only channel. Each band carries an icon as well, so the
// reading survives a colour-vision difference and a greyscale screenshot.
const BAND_PRESENTATION: Record<
  ScoreBand,
  { token: string; Icon: typeof CheckCircle2Icon; label: string }
> = {
  strong: { token: "var(--score-strong)", Icon: CheckCircle2Icon, label: "Strong" },
  mixed: { token: "var(--score-mixed)", Icon: CircleDotIcon, label: "Mixed" },
  weak: { token: "var(--score-weak)", Icon: MinusCircleIcon, label: "Needs work" },
};

function Score({
  value,
  label,
  hint,
}: {
  value: number;
  label: string;
  hint: string;
}) {
  const band = bandFor(value);
  const { token, Icon, label: bandLabel } = BAND_PRESENTATION[band];

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline gap-2">
        {/* Tabular numerals so a column of scores does not shimmer as it
            updates and stays aligned between rows. */}
        <span
          className="font-mono text-2xl tabular-nums"
          style={{ color: token }}
        >
          {value}
        </span>
        <span className="text-xs text-ink-faint">/ 10</span>
        <Icon aria-hidden className="size-3.5" style={{ color: token }} />
        {/* The band in words, so the icon and colour are never carrying the
            meaning alone. */}
        <span className="sr-only">{bandLabel}</span>
      </div>
      <span className="text-sm text-ink">{label}</span>
      <span className="text-xs leading-relaxed text-ink-subtle">{hint}</span>
    </div>
  );
}

function ScoreRow({
  correctness,
  clarity,
  depth,
}: {
  correctness: number;
  clarity: number;
  depth: number;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      <Score
        value={correctness}
        label={MESSAGES.RESULT_DIMENSION_CORRECTNESS}
        hint={MESSAGES.RESULT_DIMENSION_CORRECTNESS_HINT}
      />
      <Score
        value={clarity}
        label={MESSAGES.RESULT_DIMENSION_CLARITY}
        hint={MESSAGES.RESULT_DIMENSION_CLARITY_HINT}
      />
      <Score
        value={depth}
        label={MESSAGES.RESULT_DIMENSION_DEPTH}
        hint={MESSAGES.RESULT_DIMENSION_DEPTH_HINT}
      />
    </div>
  );
}

function AnswerCard({ item, index }: { item: EvaluationView; index: number }) {
  return (
    <article className="flex flex-col gap-5 rounded-lg border border-border p-5">
      <header className="flex flex-col gap-2">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
          {/* Numbered because the answers genuinely are a sequence — this is
              the order they were asked. */}
          {String(index + 1).padStart(2, "0")}
        </span>
        <h3 className="text-base leading-snug text-ink">{item.questionText}</h3>
        {item.interrupted ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-subtle">
            <ScissorsIcon aria-hidden className="size-3.5" />
            {MESSAGES.RESULT_INTERRUPTED}
          </span>
        ) : null}
      </header>

      <ScoreRow
        correctness={item.correctness}
        clarity={item.clarity}
        depth={item.depth}
      />

      <Separator />

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-ink-faint">
            {MESSAGES.RESULT_YOUR_ANSWER}
          </span>
          {/* Their own words, so the score has something to sit against. A
              rating with no visible answer is unreadable as feedback. */}
          <p className="text-sm leading-relaxed text-ink-muted">
            {item.transcript.length > 0 ? item.transcript : "—"}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-wide text-ink-faint">
            {MESSAGES.RESULT_WHAT_WOULD_HELP}
          </span>
          {/* The coaching. Framed as what would have helped rather than what
              was wrong — the candidate is already nervous. */}
          <p className="text-sm leading-relaxed text-ink">{item.rationale}</p>
        </div>
      </div>
    </article>
  );
}

type PageState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; result: EvaluationResponse };

export function Result() {
  const navigate = useNavigate();
  // A path parameter rather than router state: feedback is worth returning to,
  // and a URL that survives a reload is the difference between a result someone
  // can revisit and one that exists only until they navigate away.
  const { sessionId } = useParams<{ sessionId: string }>();

  const [page, setPage] = useState<PageState>({ status: "loading" });
  // Read inside the poll without making it a dependency, which would tear down
  // and rebuild the interval on every tick.
  const finishedRef = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (sessionId === undefined) return;

    try {
      const result = await fetchEvaluation(sessionId);
      finishedRef.current = isEvaluationFinished(result);
      setPage({ status: "ready", result });
    } catch (error) {
      finishedRef.current = true;
      setPage({
        status: "error",
        message: transportMessage(error, MESSAGES.RESULT_LOAD_FAILED),
      });
    }
  }, [sessionId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Polls only while answers are still landing, and stops the moment the round
  // is finished or the request failed — a page left open overnight must not
  // keep asking.
  useEffect(() => {
    if (sessionId === undefined) return;

    const timer = setInterval(() => {
      if (finishedRef.current) {
        clearInterval(timer);
        return;
      }
      void load();
    }, POLL_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [load, sessionId]);

  // Arriving with no session in the URL is a real screen, not a crash.
  if (sessionId === undefined) {
    return (
      <Interstitial
        title={MESSAGES.RESULT_MISSING_SESSION}
        action={
          <Button className="cursor-pointer" onClick={() => void navigate("/start")}>
            {MESSAGES.RESULT_BACK}
          </Button>
        }
      />
    );
  }

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
      <Interstitial
        title={MESSAGES.RESULT_LOAD_FAILED}
        body={page.message}
        action={
          <Button variant="outline" className="cursor-pointer" onClick={() => void load()}>
            <RefreshCwIcon aria-hidden className="size-4" />
            {MESSAGES.RETRY}
          </Button>
        }
      />
    );
  }

  const { result } = page;

  if (result.status === "failed") {
    return (
      <Interstitial
        title={MESSAGES.RESULT_FAILED_TITLE}
        body={MESSAGES.RESULT_FAILED_BODY}
        action={
          <Button className="cursor-pointer" onClick={() => void navigate("/start")}>
            {MESSAGES.RESULT_BACK}
          </Button>
        }
      />
    );
  }

  // Nothing was recorded, so there is nothing coming. An empty state rather
  // than a spinner that would never resolve.
  if (result.total === 0 && result.evaluations.length === 0) {
    return (
      <Interstitial
        title={MESSAGES.RESULT_EMPTY_TITLE}
        body={MESSAGES.RESULT_EMPTY_BODY}
        action={
          <Button className="cursor-pointer" onClick={() => void navigate("/start")}>
            {MESSAGES.RESULT_BACK}
          </Button>
        }
      />
    );
  }

  const scoring = result.averages === undefined;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 pb-16">
      <header className="flex flex-col gap-3">
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
          {MESSAGES.RESULT_TITLE}
        </span>
        <h2 className="font-display text-3xl text-ink">
          {scoring ? MESSAGES.RESULT_SCORING_TITLE : (result.role ?? MESSAGES.RESULT_TITLE)}
        </h2>

        {scoring ? (
          <div className="flex flex-col gap-2">
            <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
              {MESSAGES.RESULT_SCORING_BODY}
            </p>
            {/* The count is what makes the wait legible. An unlabelled spinner
                is indistinguishable from a stuck one. */}
            <div className="flex items-center gap-3">
              <Progress
                value={result.total === 0 ? 0 : (result.completed / result.total) * 100}
                className="h-1.5 max-w-xs"
              />
              <span className="font-mono text-xs tabular-nums text-ink-subtle">
                {MESSAGES.RESULT_PROGRESS(result.completed, result.total)}
              </span>
            </div>
          </div>
        ) : null}
      </header>

      {/* One step up the surface ladder, so the whole-interview rollup reads as
          a summary of the cards below rather than as another card. */}
      {result.averages !== undefined ? (
        <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface-2 p-5">
          <span className="text-xs uppercase tracking-wide text-ink-faint">
            {MESSAGES.RESULT_OVERALL}
          </span>
          <ScoreRow
            correctness={result.averages.correctness}
            clarity={result.averages.clarity}
            depth={result.averages.depth}
          />
        </section>
      ) : null}

      <section className="flex flex-col gap-4">
        {result.evaluations.map((item, index) => (
          // Keyed on the question id, never the array index: rows arrive one at
          // a time while polling, and an index key would remount every card
          // each time a new score lands.
          <AnswerCard key={item.questionId} item={item} index={index} />
        ))}
      </section>

      <div className="flex justify-center">
        <Button
          variant="outline"
          className="cursor-pointer"
          onClick={() => void navigate("/start")}
        >
          {MESSAGES.RESULT_BACK}
        </Button>
      </div>
    </div>
  );
}

function Interstitial({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col items-center justify-center gap-5 p-6 text-center">
      <AlertTriangleIcon aria-hidden className="size-5 text-ink-subtle" />
      <h2 className="font-display text-2xl text-ink">{title}</h2>
      {/* Only when it adds something. `transportMessage` falls back to the same
          copy used as the title when it cannot classify a failure, and a screen
          that states its one sentence twice reads as a bug. */}
      {body !== undefined && body !== title ? (
        <p className="max-w-md text-sm leading-relaxed text-ink-muted">{body}</p>
      ) : null}
      {action}
    </div>
  );
}
