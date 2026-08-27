import { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import {
  PlanResponseSchema,
  PreInterviewBody,
  PreInterviewResponse,
  UPLOAD_FIELDS,
  type PlanResponse,
  type PreInterviewResponse as PreInterview,
} from "@repo/shared";

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
import { ResumeField } from "@/components/ResumeField";
import { SessionPlan } from "@/components/SessionPlan";
import { api } from "@/lib/api";
import {
  MESSAGES,
  TARGET_ROLE_PRESETS,
  resumeThinDetail,
} from "@/lib/messages";

// Rendered from one discriminated union rather than several booleans, so states
// like "uploading and reading at once" are unrepresentable instead of merely
// unlikely.
type Submission =
  | { status: "idle" }
  | { status: "uploading"; percent: number }
  | { status: "reading" }
  // The PDF parsed but yielded almost nothing. A result to show, not an error:
  // the candidate chooses whether to proceed or attach a different file.
  | { status: "thin"; result: PreInterview }
  // The session exists and the model is building the plan. Carries the result
  // so a retry can re-plan against the same session instead of re-uploading.
  | { status: "planning"; result: PreInterview }
  | { status: "planned"; result: PreInterview; plan: PlanResponse }
  // Its own state, not a toast. A model call needs a visible retry path, and
  // the session is still good — sending the candidate back to the file picker
  // would make them redo work that succeeded.
  | { status: "plan-failed"; result: PreInterview; message: string };

// The server rejects an unverifiable token with 401. That is a session problem,
// not a bad GitHub URL, so it gets its own message rather than the generic one.
function isUnauthorized(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

type ServerFailure = { message: string; scope: "field" | "global" };

// Where a failure belongs on screen depends on whose problem it is.
//
// 413/422 describe the file the candidate chose — the exact size, the exact
// limit — so they belong on the field, next to the thing they can change.
// A 500 means the server could not do its job; showing that beside their file
// input would send them re-picking PDFs to fix something that is not theirs.
function serverFailure(error: unknown): ServerFailure | null {
  if (!axios.isAxiosError(error)) return null;

  const data: unknown = error.response?.data;
  const message =
    typeof data === "object" && data !== null && "message" in data &&
    typeof (data as { message: unknown }).message === "string"
      ? (data as { message: string }).message
      : "";

  if (message.length === 0) return null;

  const status = error.response?.status;
  if (status === 413 || status === 422) return { message, scope: "field" };
  if (status === 500 || status === 502) return { message, scope: "global" };
  return null;
}

// No response at all: the request never reached a server that could answer, so
// this is a dropped connection, a backend that is not running, or CORS.
//
// Worth its own message because the generic fallback used to claim the GitHub
// profile was unreadable, which sent people to re-check a URL that was fine
// while the real problem was that nothing was listening.
function isUnreachable(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response === undefined;
}

// Which message a failed plan call deserves. The distinctions matter because
// the recovery differs: a missing session means start over, an already-started
// one cannot be replanned at all, and everything else is worth retrying.
function planFailureMessage(error: unknown): string {
  if (isUnauthorized(error)) return MESSAGES.FORM_SESSION_EXPIRED;
  if (isUnreachable(error)) return MESSAGES.FORM_UNREACHABLE;
  if (!axios.isAxiosError(error)) return MESSAGES.PLAN_FAILED_GENERIC;

  switch (error.response?.status) {
    case 404:
      return MESSAGES.PLAN_SESSION_MISSING;
    case 409:
      return MESSAGES.PLAN_ALREADY_STARTED;
    default:
      return MESSAGES.PLAN_FAILED_GENERIC;
  }
}

// A failure the candidate cannot retry their way out of — the session is gone
// or spent, so the only way forward is new inputs.
function isTerminalPlanFailure(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === 404 || status === 409;
}

export function Form() {
  const navigate = useNavigate();
  const [gitHub, setGitHub] = useState("");
  const [targetRole, setTargetRole] = useState("");
  const [roleError, setRoleError] = useState<string | null>(null);
  const [resume, setResume] = useState<File | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<Submission>({ status: "idle" });

  const isBusy =
    submission.status === "uploading" ||
    submission.status === "reading" ||
    submission.status === "planning";

  const goToInterview = (result: PreInterview, plan: PlanResponse) => {
    // The session and its plan are both persisted now, so this only carries
    // what saves the next screen a round trip — it is a cache, not the source
    // of truth. The interview screen re-reads by sessionId.
    navigate("/interview", { state: { sessionId: result.sessionId, plan } });
  };

  // Split from the upload deliberately. The session already exists by the time
  // this runs, so a failure here is retryable on its own — the candidate never
  // re-uploads a resume that stored fine.
  const requestPlan = async (result: PreInterview) => {
    setSubmission({ status: "planning", result });

    try {
      const response = await api.post("/api/v1/plan", {
        sessionId: result.sessionId,
        targetRole: targetRole.trim(),
      });

      const parsed = PlanResponseSchema.safeParse(response.data);
      if (!parsed.success) {
        setSubmission({
          status: "plan-failed",
          result,
          message: MESSAGES.PLAN_UNEXPECTED_RESPONSE,
        });
        return;
      }

      setSubmission({ status: "planned", result, plan: parsed.data });
    } catch (error) {
      const message = planFailureMessage(error);

      // Nothing to retry against — back to the form with the reason, rather
      // than a retry button that will fail the same way every time.
      if (isTerminalPlanFailure(error)) {
        toast.error(message);
        setSubmission({ status: "idle" });
        return;
      }

      setSubmission({ status: "plan-failed", result, message });
    }
  };

  const handleSubmit = async () => {
    // The resume is the required input, so this is checked first — telling
    // someone their GitHub URL is malformed when the real blocker is a missing
    // file sends them to the wrong field.
    if (resume === null) {
      setResumeError(MESSAGES.RESUME_MISSING);
      return;
    }

    // Required, and checked before the upload rather than after: the plan call
    // follows immediately, and discovering a missing role once the resume is
    // already stored would waste the upload.
    if (targetRole.trim().length === 0) {
      setRoleError(MESSAGES.FORM_ROLE_REQUIRED);
      return;
    }

    // GitHub is optional. An empty field is folded to undefined by the shared
    // schema, so only a non-empty, non-URL value produces an error here.
    const validated = PreInterviewBody.safeParse({ gitHub: gitHub.trim() });
    if (!validated.success) {
      toast.warning(
        validated.error.issues[0]?.message ?? MESSAGES.FORM_FAILED
      );
      return;
    }

    setResumeError(null);
    setSubmission({ status: "uploading", percent: 0 });

    try {
      const body = new FormData();
      // Omitted rather than sent empty — the server distinguishes "no profile
      // given" from "a profile that failed to parse".
      if (validated.data.gitHub !== undefined) {
        body.append(UPLOAD_FIELDS.GITHUB, validated.data.gitHub);
      }
      body.append(UPLOAD_FIELDS.RESUME, resume);

      const response = await api.post("/api/v1/pre-interview", body, {
        // Real bytes-sent progress, not a simulated bar. Once the last byte is
        // out the wait becomes server-side parsing, which has no progress to
        // report — so the phase changes rather than the bar stalling at 100%
        // and looking hung.
        onUploadProgress: (event) => {
          if (event.total === undefined || event.total === 0) return;
          const percent = Math.round((event.loaded / event.total) * 100);
          setSubmission(
            percent >= 100
              ? { status: "reading" }
              : { status: "uploading", percent }
          );
        },
      });

      const parsed = PreInterviewResponse.safeParse(response.data);
      if (!parsed.success) {
        toast.error(MESSAGES.FORM_UNEXPECTED_RESPONSE);
        setSubmission({ status: "idle" });
        return;
      }

      const result = parsed.data;
      if (result.resume !== undefined && !result.resume.usable) {
        setSubmission({ status: "thin", result });
        return;
      }

      await requestPlan(result);
    } catch (error) {
      const failure = serverFailure(error);
      if (failure?.scope === "field") {
        setResumeError(failure.message);
      } else if (failure?.scope === "global") {
        toast.error(failure.message);
      } else if (isUnauthorized(error)) {
        toast.error(MESSAGES.FORM_SESSION_EXPIRED);
      } else if (isUnreachable(error)) {
        toast.error(MESSAGES.FORM_UNREACHABLE);
      } else {
        toast.error(MESSAGES.FORM_FAILED);
      }
      setSubmission({ status: "idle" });
    }
  };

  if (submission.status === "planned") {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <SessionPlan
          plan={submission.plan}
          onBegin={() => goToInterview(submission.result, submission.plan)}
          // Back to the form with the inputs intact. The resume file object is
          // still in state, so changing only the role and regenerating does not
          // mean re-picking the PDF.
          onStartOver={() => setSubmission({ status: "idle" })}
        />
      </div>
    );
  }

  if (submission.status === "plan-failed") {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangleIcon className="size-4 shrink-0 text-muted-foreground" />
              {MESSAGES.PLAN_FAILED_TITLE}
            </CardTitle>
            <CardDescription>{submission.message}</CardDescription>
          </CardHeader>

          <CardFooter className="mt-4 flex-col gap-2">
            {/* Retries the plan alone, against the session that already
                exists. The copy above promises no re-upload; this is what
                keeps that promise. */}
            <Button
              className="w-full cursor-pointer"
              onClick={() => void requestPlan(submission.result)}
            >
              {MESSAGES.PLAN_FAILED_RETRY}
            </Button>
            <Button
              variant="ghost"
              className="w-full cursor-pointer"
              onClick={() => setSubmission({ status: "idle" })}
            >
              {MESSAGES.PLAN_START_OVER}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  if (submission.status === "thin") {
    const characters = submission.result.resume?.characters ?? 0;

    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangleIcon className="size-4 shrink-0 text-muted-foreground" />
              {MESSAGES.RESUME_THIN_TITLE}
            </CardTitle>
            <CardDescription>{resumeThinDetail(characters)}</CardDescription>
          </CardHeader>

          <CardFooter className="mt-4 flex-col gap-2">
            <Button
              className="w-full cursor-pointer"
              onClick={() => void requestPlan(submission.result)}
            >
              {MESSAGES.RESUME_CONTINUE_ANYWAY}
            </Button>
            <Button
              variant="ghost"
              className="w-full cursor-pointer"
              onClick={() => {
                setResume(null);
                setSubmission({ status: "idle" });
              }}
            >
              {MESSAGES.RESUME_TRY_ANOTHER}
            </Button>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-full w-full items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{MESSAGES.FORM_TITLE}</CardTitle>
          <CardDescription>{MESSAGES.FORM_DESCRIPTION}</CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          {/* Resume first: it is the required input, and the order on screen
              should match what the form actually needs. */}
          <ResumeField
            file={resume}
            error={resumeError}
            disabled={isBusy}
            onSelect={(file) => {
              setResume(file);
              setResumeError(null);
            }}
            onReject={(message) => {
              setResume(null);
              setResumeError(message);
            }}
            onClear={() => {
              setResume(null);
              setResumeError(null);
            }}
          />

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
                  targetRole.trim().length === 0 ? MESSAGES.FORM_ROLE_REQUIRED : null
                )
              }
            />
            <p
              id="role-hint"
              className={
                roleError !== null
                  ? "text-xs text-destructive"
                  : "text-xs text-muted-foreground"
              }
            >
              {roleError ?? MESSAGES.FORM_ROLE_HINT}
            </p>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="github">{MESSAGES.FORM_GITHUB_LABEL}</Label>
              <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
                {MESSAGES.FORM_GITHUB_OPTIONAL}
              </span>
            </div>
            <Input
              id="github"
              type="url"
              inputMode="url"
              autoComplete="url"
              placeholder={MESSAGES.FORM_GITHUB_PLACEHOLDER}
              value={gitHub}
              disabled={isBusy}
              aria-describedby="github-hint"
              onChange={(e) => setGitHub(e.target.value)}
            />
            <p id="github-hint" className="text-xs text-muted-foreground">
              {MESSAGES.FORM_GITHUB_HINT}
            </p>
          </div>
        </CardContent>

        <CardFooter className="mt-6 flex-col gap-3">
          {/* Space is reserved by the conditional block rather than a spinner
              sitting where content will land. Announced politely so the phase
              change is available without watching the bar. */}
          {isBusy ? (
            <div className="w-full space-y-2" aria-live="polite">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                {/* Three named phases, not one bar. Only the upload has real
                    progress to report; the other two are server-side waits, so
                    naming them is the only honest signal that something is
                    still happening. */}
                <span>
                  {submission.status === "uploading"
                    ? MESSAGES.RESUME_PHASE_UPLOADING
                    : submission.status === "reading"
                      ? MESSAGES.RESUME_PHASE_READING
                      : MESSAGES.PLAN_PHASE_BUILDING}
                </span>
                {submission.status === "uploading" ? (
                  <span className="tabular-nums">{submission.percent}%</span>
                ) : null}
              </div>
              <Progress
                value={submission.status === "uploading" ? submission.percent : null}
                className={
                  submission.status === "uploading"
                    ? undefined
                    : "animate-pulse motion-reduce:animate-none"
                }
              />
            </div>
          ) : null}

          <Button
            className="w-full cursor-pointer"
            onClick={handleSubmit}
            disabled={isBusy}
          >
            {isBusy ? MESSAGES.FORM_SUBMIT_PENDING : MESSAGES.FORM_SUBMIT}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
