import { MicIcon } from "lucide-react";
import type { PlanResponse } from "@repo/shared";

import { Button } from "@/components/ui/button";
import { Eyebrow } from "@/components/Eyebrow";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { MESSAGES } from "@/lib/messages";

// Wraps Card with the session's semantics rather than forking it, so upstream
// shadcn fixes still apply.
//
// The visual model is the data-dense card from
// docs/design/references/supabase-design.md: a statistic strip in mono, then
// rows that each carry their own provenance. The plan is evidence, and the
// layout should let a candidate audit it at a glance rather than admire it.

type Props = {
  plan: PlanResponse;
  onBegin: () => void;
  onStartOver: () => void;
};

// A stat, not a score. Mono and tabular so the three columns line up and do not
// shimmer if a plan is regenerated in place.
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1 px-2">
      <span className="font-mono text-2xl text-ink tabular-nums">{value}</span>
      <Eyebrow size="sm">{label}</Eyebrow>
    </div>
  );
}

export function SessionPlan({ plan, onBegin, onStartOver }: Props) {
  const questionCount =
    plan.questionMix.behavioural +
    plan.questionMix.technical +
    plan.questionMix.roleSpecific;

  return (
    <Card className="w-full max-w-lg">
      <CardHeader>
        <Eyebrow>{MESSAGES.PLAN_EYEBROW}</Eyebrow>
        <div className="flex items-start justify-between gap-3">
          <h1 className="font-display text-3xl leading-[1.15] sm:text-4xl">
            {MESSAGES.PLAN_TITLE}
          </h1>
          {/* A word, not a coloured dot. Colour is never the only channel. */}
          <span className="mt-1 shrink-0 rounded-full border border-state-recording/40 bg-state-recording/10 px-2.5 py-0.5 text-xs font-medium text-state-recording">
            {MESSAGES.PLAN_READY_BADGE}
          </span>
        </div>
        <CardDescription>{MESSAGES.PLAN_DESCRIPTION}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center divide-x divide-hairline rounded-xl border border-hairline bg-surface-2 py-4">
          <Stat
            value={String(questionCount)}
            label={MESSAGES.PLAN_STAT_QUESTIONS}
          />
          <Stat
            value={`${plan.targetMinutes}m`}
            label={MESSAGES.PLAN_STAT_DURATION}
          />
          <Stat
            value={String(plan.focusAreas.length)}
            label={MESSAGES.PLAN_STAT_FOCUSES}
          />
        </div>

        <div className="flex flex-col gap-3">
          <Eyebrow as="h2">{MESSAGES.PLAN_FOCUS_AREAS}</Eyebrow>
          <ul className="flex flex-col">
            {plan.focusAreas.map((focus, index) => (
              // Keyed on the area itself. The Planner is bounded to a handful of
              // distinct areas, and an index key would remount every row if a
              // plan were ever regenerated in place.
              <li
                key={focus.area}
                className="flex items-start gap-4 border-b border-hairline py-3 last:border-b-0"
              >
                {/* Numbered because the focus areas are a genuine running
                    order, not a decorated bullet list. */}
                <span className="pt-0.5 font-mono text-xs text-cue-ink tabular-nums">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="text-sm text-ink">{focus.area}</span>
                  {/* The evidence line is the reason to trust the plan: it names
                      the repo or resume line the question will come from, so the
                      candidate can see it was not generic. */}
                  <span className="flex items-start gap-2 text-xs leading-relaxed text-ink-subtle">
                    {/* Provenance as a word, not a glyph. The icon here was the
                        only visual channel a sighted reader had for "this came
                        from GitHub" while the screen-reader text said it
                        outright — two renderings of one fact, and the quieter
                        was the one most people saw. A mono tag serves both. */}
                    <Eyebrow size="sm" className="mt-0.5 shrink-0">
                      {focus.source === "github"
                        ? MESSAGES.PLAN_SOURCE_GITHUB
                        : MESSAGES.PLAN_SOURCE_RESUME}
                    </Eyebrow>
                    {/* Wrapped to two lines rather than truncated. Cutting it at
                        "…vector search for i…" removes the specific detail that
                        proves the question came from this candidate's work. */}
                    <span className="line-clamp-2">{focus.evidence}</span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Framed as a starting point, because it is one — the interview moves
            off this level based on the answers. Presenting it as a fixed
            setting would both misdescribe the product and read as a verdict
            before a single question has been asked. */}
        <p className="text-xs leading-relaxed text-ink-subtle">
          <span className="font-medium capitalize text-ink">
            {plan.startingDifficulty}
          </span>{" "}
          · {MESSAGES.PLAN_DIFFICULTY_NOTE}
        </p>
      </CardContent>

      <CardFooter className="flex-col gap-2">
        <Button size="lg" className="w-full cursor-pointer" onClick={onBegin}>
          <MicIcon aria-hidden className="size-4" />
          {MESSAGES.PLAN_BEGIN}
        </Button>
        <Button
          variant="ghost"
          className="w-full cursor-pointer text-ink-subtle hover:text-ink"
          onClick={onStartOver}
        >
          {MESSAGES.PLAN_START_OVER}
        </Button>
      </CardFooter>
    </Card>
  );
}
