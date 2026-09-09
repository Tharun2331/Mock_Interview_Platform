import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import {
  AlertTriangleIcon,
  CheckIcon,
  FileTextIcon,
  FolderGit2Icon,
} from "lucide-react";
import { PlanResponseSchema, type PlanResponse } from "@repo/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { SessionPlan } from "@/components/SessionPlan";
import { api } from "@/lib/api";
import { useProfile } from "@/lib/profile";
import {
  isUnauthorized,
  isTimeout,
  isUnreachable,
  statusOf,
  transportMessage,
} from "@/lib/httpErrors";
import { MESSAGES, TARGET_ROLE_PRESETS } from "@/lib/messages";

// What is left of the old setup form once the resume and GitHub moved to the
// profile: choose a role, and go.
//
// The upload states are gone with the upload. What remains is two server calls —
// mint a session from the stored profile, then plan it — and the plan is the
// only one slow enough to need a phase of its own.
type Setup =
  | { status: "idle" }
  | { status: "creating" }
  // The session exists and the model is building the plan. Carries the id so a
  // retry re-plans against the same session rather than minting a second one.
  | { status: "planning"; sessionId: string }
  | { status: "planned"; sessionId: string; plan: PlanResponse }
  // Its own state, not a toast. A model call needs a visible retry path, and
  // the session is still good — sending the candidate back to the role field
  // would make them redo work that succeeded.
  | { status: "failed"; sessionId: string; message: string };

// Which message a failed plan call deserves. The distinctions matter because
// the recovery differs: a missing session means start over, an already-started
// one cannot be replanned at all, and everything else is worth retrying.
function planFailureMessage(error: unknown): string {
  const status = statusOf(error);
  if (status === 404) return MESSAGES.PLAN_SESSION_MISSING;
  if (status === 409) return MESSAGES.PLAN_ALREADY_STARTED;
  return transportMessage(error, MESSAGES.PLAN_FAILED_GENERIC);
}

// A failure the candidate cannot retry their way out of — the session is gone
// or spent, so the only way forward is a new one.
function isTerminal(error: unknown): boolean {
  const status = statusOf(error);
  return status === 404 || status === 409;
}

export function StartInterview() {
  const navigate = useNavigate();
  const state = useProfile();
  const profile = state.status === "ready" ? state.profile : null;

  const [targetRole, setTargetRole] = useState("");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup>({ status: "idle" });

  const isBusy = setup.status === "creating" || setup.status === "planning";

  // Split from session creation deliberately. The session already exists by the
  // time this runs, so a failure here is retryable on its own.
  const requestPlan = async (sessionId: string) => {
    setSetup({ status: "planning", sessionId });

    try {
      const response = await api.post("/api/v1/plan", {
        sessionId,
        targetRole: targetRole.trim(),
      });

      const parsed = PlanResponseSchema.safeParse(response.data);
      if (!parsed.success) {
        setSetup({
          status: "failed",
          sessionId,
          message: MESSAGES.PLAN_UNEXPECTED_RESPONSE,
        });
        return;
      }

      setSetup({ status: "planned", sessionId, plan: parsed.data });
    } catch (error) {
      const message = planFailureMessage(error);

      // Nothing to retry against — back to the form with the reason, rather
      // than a retry button that will fail the same way every time.
      if (isTerminal(error)) {
        toast.error(message);
        setSetup({ status: "idle" });
        return;
      }

      setSetup({ status: "failed", sessionId, message });
    }
  };

  const handleSubmit = async () => {
    if (targetRole.trim().length === 0) {
      setRoleError(MESSAGES.FORM_ROLE_REQUIRED);
      return;
    }

    setRoleError(null);
    setSetup({ status: "creating" });

    try {
      // No body. Everything the session needs comes from the stored profile —
      // sending material from the browser is what let a caller plan against
      // somebody else's resume, and the route stopped accepting it.
      const response = await api.post("/api/v1/pre-interview");
      const sessionId: unknown = (response.data as { sessionId?: unknown })
        ?.sessionId;

      if (typeof sessionId !== "string" || sessionId.length === 0) {
        toast.error(MESSAGES.FORM_UNEXPECTED_RESPONSE);
        setSetup({ status: "idle" });
        return;
      }

      await requestPlan(sessionId);
    } catch (error) {
      setSetup({ status: "idle" });

      // The guard should have caught this, so reaching it means the profile
      // was cleared in another tab. Sending them to fix it beats a generic
      // failure that gives no way forward.
      if (statusOf(error) === 409) {
        toast.warning(MESSAGES.START_PROFILE_INCOMPLETE);
        navigate("/profile");
        return;
      }

      if (isUnauthorized(error) || isTimeout(error) || isUnreachable(error)) {
        toast.error(transportMessage(error, MESSAGES.FORM_FAILED));
        return;
      }
      toast.error(MESSAGES.FORM_FAILED);
    }
  };

  if (setup.status === "planned") {
    return (
      <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
        <SessionPlan
          plan={setup.plan}
          // The session and its plan are both persisted, so this only saves the
          // next screen a round trip — it is a cache, not the source of truth.
          onBegin={() =>
            navigate("/interview", {
              state: { sessionId: setup.sessionId, plan: setup.plan },
            })
          }
          onStartOver={() => setSetup({ status: "idle" })}
        />
      </div>
    );
  }

  if (setup.status === "failed") {
    return (
      <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-2xl">
              <AlertTriangleIcon
                aria-hidden
                className="size-4 shrink-0 text-score-mixed"
              />
              {MESSAGES.PLAN_FAILED_TITLE}
            </CardTitle>
            <CardDescription>{setup.message}</CardDescription>
          </CardHeader>
          <CardFooter className="mt-4 flex-col gap-2">
            {/* Retries the plan alone, against the session that already
                exists — no second session, no re-picking a role. */}
            <Button
              className="w-full cursor-pointer"
              onClick={() => void requestPlan(setup.sessionId)}
            >
              {MESSAGES.PLAN_FAILED_RETRY}
            </Button>
            <Button
              variant="ghost"
              className="w-full cursor-pointer text-ink-subtle hover:text-ink"
              onClick={() => setSetup({ status: "idle" })}
            >
              {MESSAGES.PLAN_START_OVER}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
            {MESSAGES.START_EYEBROW}
          </span>
          <CardTitle className="font-display text-3xl">
            {MESSAGES.START_TITLE}
          </CardTitle>
          <CardDescription className="leading-relaxed">
            {MESSAGES.START_DESCRIPTION}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* What this round will be built from, named rather than assumed.
              The material now lives a page away, so without this the candidate
              has no way to tell whether the resume being used is the one they
              meant — and the edit link is how they check. */}
          {profile !== null ? (
            <div className="flex flex-col gap-2 rounded-md border border-hairline bg-surface-2 px-3 py-2.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[0.7rem] uppercase tracking-[0.12em] text-ink-faint">
                  {MESSAGES.START_MATERIAL_TITLE}
                </span>
                <Link
                  to="/profile"
                  className="text-xs text-ink-subtle underline underline-offset-2 hover:text-ink"
                >
                  {MESSAGES.START_MATERIAL_EDIT}
                </Link>
              </div>
              <ul className="flex flex-col gap-1 text-sm">
                <li className="flex items-center gap-2">
                  <FileTextIcon
                    aria-hidden
                    className="size-3.5 shrink-0 text-cue-ink"
                  />
                  {MESSAGES.START_MATERIAL_RESUME}
                </li>
                {profile.githubUsername !== undefined ? (
                  <li className="flex items-center gap-2">
                    <FolderGit2Icon
                      aria-hidden
                      className="size-3.5 shrink-0 text-cue-ink"
                    />
                    {/* Tabular numerals so the repo count does not shimmer. */}
                    <span className="truncate">
                      {profile.githubUsername}
                      <span className="text-ink-subtle tabular-nums">
                        {" · "}
                        {profile.repoCount}
                      </span>
                    </span>
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="role">{MESSAGES.FORM_ROLE_LABEL}</Label>

            {/* Shortcuts that fill the input rather than a separate mode. The
                input stays the single source of truth, so there is no state
                where a chip is lit and the field says something else. */}
            <div className="grid grid-cols-2 gap-2">
              {TARGET_ROLE_PRESETS.map((preset) => {
                const selected = targetRole.trim() === preset;
                return (
                  <Button
                    key={preset}
                    type="button"
                    variant={selected ? "default" : "outline"}
                    aria-pressed={selected}
                    disabled={isBusy}
                    className="cursor-pointer justify-start text-sm font-normal"
                    onClick={() => {
                      setTargetRole(preset);
                      setRoleError(null);
                    }}
                  >
                    {/* Selection is carried by the filled variant and by
                        aria-pressed, with the check as a third channel —
                        colour alone is never the signal. */}
                    {selected ? (
                      <CheckIcon aria-hidden className="size-4 shrink-0" />
                    ) : null}
                    <span className="truncate">{preset}</span>
                  </Button>
                );
              })}
            </div>

            <Input
              id="role"
              value={targetRole}
              disabled={isBusy}
              placeholder={MESSAGES.FORM_ROLE_PLACEHOLDER}
              aria-describedby="role-hint"
              aria-invalid={roleError !== null}
              onChange={(e) => setTargetRole(e.target.value)}
              // Validated on blur, not per keystroke — an error appearing while
              // someone is still typing the first letter reads as scolding.
              onBlur={() =>
                setRoleError(
                  targetRole.trim().length === 0
                    ? MESSAGES.FORM_ROLE_REQUIRED
                    : null
                )
              }
            />
            <p
              id="role-hint"
              className={
                roleError !== null
                  ? "text-xs text-destructive"
                  : "text-xs text-ink-subtle"
              }
            >
              {roleError ?? MESSAGES.FORM_ROLE_HINT}
            </p>
          </div>
        </CardContent>

        <CardFooter className="mt-6 flex-col gap-3">
          {/* Space is reserved by the conditional block rather than a spinner
              sitting where content will land. Announced politely so the phase
              change is available without watching the bar. */}
          {isBusy ? (
            <div className="w-full space-y-2" aria-live="polite">
              <p className="font-mono text-xs text-ink-subtle">
                {setup.status === "creating"
                  ? MESSAGES.START_PHASE_CREATING
                  : MESSAGES.PLAN_PHASE_BUILDING}
              </p>
              <Progress
                value={null}
                className="animate-pulse motion-reduce:animate-none"
              />
            </div>
          ) : null}

          <Button
            size="lg"
            className="w-full cursor-pointer"
            onClick={handleSubmit}
            disabled={isBusy}
          >
            {isBusy ? MESSAGES.START_SUBMIT_PENDING : MESSAGES.START_SUBMIT}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
