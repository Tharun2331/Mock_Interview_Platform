import { CheckIcon, FolderGit2Icon, FileTextIcon, MicIcon } from "lucide-react";
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

type Props = {
  plan: PlanResponse;
  onBegin: () => void;
  onStartOver: () => void;
};

// A stat, not a score. Tabular numerals so the three columns line up and do not
// shimmer if a plan is regenerated in place.
function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-0.5 px-2">
      <span className="text-2xl font-semibold tabular-nums">{value}</span>
      <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
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
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <CardTitle>{MESSAGES.PLAN_TITLE}</CardTitle>
          {/* Text, not a coloured dot. Colour is never the only channel for
              state — see the quality floor in the frontend skill. */}
          <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-medium text-primary-foreground">
            {MESSAGES.PLAN_READY_BADGE}
          </span>
        </div>
        <CardDescription>{MESSAGES.PLAN_DESCRIPTION}</CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="flex items-center justify-around rounded-lg border bg-muted/40 py-3">
          <Stat value={String(questionCount)} label={MESSAGES.PLAN_STAT_QUESTIONS} />
          <Stat value={`${plan.targetMinutes}m`} label={MESSAGES.PLAN_STAT_DURATION} />
          <Stat
            value={String(plan.focusAreas.length)}
            label={MESSAGES.PLAN_STAT_FOCUSES}
          />
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
            {MESSAGES.PLAN_FOCUS_AREAS}
          </h3>
          <ul className="flex flex-col gap-2.5">
            {plan.focusAreas.map((focus) => (
              // Keyed on the area itself. The Planner is bounded to a handful of
              // distinct areas, and an index key would remount every row if a
              // plan were ever regenerated in place.
              <li key={focus.area} className="flex items-start gap-2">
                <CheckIcon
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-primary"
                />
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm">{focus.area}</span>
                  {/* The evidence line is the reason to trust the plan: it
                      names the repo or resume line the question will come
                      from, so the candidate can see it was not generic. */}
                  {/* Wrapped to two lines rather than truncated. The evidence
                      is the reason to trust the plan — cutting it at "…vector
                      search for i…" removes the specific detail that proves the
                      question came from this candidate's own work. Two lines
                      caps the height without losing the point. */}
                  <span className="flex items-start gap-1 text-xs text-muted-foreground">
                    {focus.source === "github" ? (
                      <FolderGit2Icon
                        aria-hidden
                        className="mt-0.5 size-3 shrink-0"
                      />
                    ) : (
                      <FileTextIcon
                        aria-hidden
                        className="mt-0.5 size-3 shrink-0"
                      />
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
        <p className="text-xs text-muted-foreground">
          <span className="font-medium capitalize text-foreground">
            {plan.startingDifficulty}
          </span>{" "}
          · {MESSAGES.PLAN_DIFFICULTY_NOTE}
        </p>
      </CardContent>

      <CardFooter className="mt-2 flex-col gap-2">
        <Button className="w-full cursor-pointer" onClick={onBegin}>
          <MicIcon aria-hidden className="size-4" />
          {MESSAGES.PLAN_BEGIN}
        </Button>
        <Button
          variant="ghost"
          className="w-full cursor-pointer"
          onClick={onStartOver}
        >
          {MESSAGES.PLAN_START_OVER}
        </Button>
      </CardFooter>
    </Card>
  );
}
