import { FolderGit2Icon, FileTextIcon, MicIcon } from "lucide-react";
import type { PlanResponse } from "@repo/shared";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
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
      <span className="text-[0.65rem] uppercase tracking-[0.12em] text-ink-faint">
        {label}
      </span>
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
        <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
          {MESSAGES.PLAN_EYEBROW}
        </span>
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="font-display text-3xl">
            {MESSAGES.PLAN_TITLE}
          </CardTitle>
          {/* A word, not a coloured dot. Colour is never the only channel. */}
          <span className="mt-1 shrink-0 rounded-full border border-state-recording/40 bg-state-recording/10 px-2.5 py-0.5 text-xs font-medium text-state-recording">
            {MESSAGES.PLAN_READY_BADGE}
          </span>
        </div>
        <CardDescription>{MESSAGES.PLAN_DESCRIPTION}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        <div className="flex items-center divide-x divide-hairline rounded-xl border border-hairline bg-surface-2 py-4">
          <Stat value={String(questionCount)} label={MESSAGES.PLAN_STAT_QUESTIONS} />
          <Stat value={`${plan.targetMinutes}m`} label={MESSAGES.PLAN_STAT_DURATION} />
          <Stat
            value={String(plan.focusAreas.length)}
            label={MESSAGES.PLAN_STAT_FOCUSES}
          />
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
            {MESSAGES.PLAN_FOCUS_AREAS}
          </h3>
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
                      candidate can see it was not generic.

                      Wrapped to two lines rather than truncated. Cutting it at
                      "…vector search for i…" removes the specific detail that
                      proves the question came from this candidate's own work. */}
                  <span className="flex items-start gap-1.5 text-xs leading-relaxed text-ink-subtle">
                    {focus.source === "github" ? (
                      <FolderGit2Icon aria-hidden className="mt-0.5 size-3 shrink-0" />
                    ) : (
                      <FileTextIcon aria-hidden className="mt-0.5 size-3 shrink-0" />
                    )}
                    <span className="sr-only">
                      {focus.source === "github"
                        ? MESSAGES.PLAN_SOURCE_GITHUB
                        : MESSAGES.PLAN_SOURCE_RESUME}
                    </span>
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
