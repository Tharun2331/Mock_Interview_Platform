import { useState } from "react";
import axios from "axios";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { AlertTriangleIcon } from "lucide-react";
import {
  PreInterviewBody,
  PreInterviewResponse,
  UPLOAD_FIELDS,
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
import { api } from "@/lib/api";
import { MESSAGES, resumeThinDetail } from "@/lib/messages";

// Rendered from one discriminated union rather than several booleans, so states
// like "uploading and reading at once" are unrepresentable instead of merely
// unlikely.
type Submission =
  | { status: "idle" }
  | { status: "uploading"; percent: number }
  | { status: "reading" }
  // The PDF parsed but yielded almost nothing. A result to show, not an error:
  // the candidate chooses whether to proceed or attach a different file.
  | { status: "thin"; result: PreInterview };

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
  if (status === 500) return { message, scope: "global" };
  return null;
}

export function Form() {
  const navigate = useNavigate();
  const [gitHub, setGitHub] = useState("");
  const [resume, setResume] = useState<File | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [submission, setSubmission] = useState<Submission>({ status: "idle" });

  const isBusy =
    submission.status === "uploading" || submission.status === "reading";

  const goToInterview = (result: PreInterview) => {
    // Router state, the same in-memory channel the sign-up flow uses. Nothing is
    // persisted yet; this moves server-side once DynamoDB lands.
    navigate("/interview", {
      state: {
        sessionId: result.sessionId,
        repos: result.repos,
        resumeText: result.resume?.text,
      },
    });
  };

  const handleSubmit = async () => {
    // The resume is the required input, so this is checked first — telling
    // someone their GitHub URL is malformed when the real blocker is a missing
    // file sends them to the wrong field.
    if (resume === null) {
      setResumeError(MESSAGES.RESUME_MISSING);
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

      goToInterview(result);
    } catch (error) {
      const failure = serverFailure(error);
      if (failure?.scope === "field") {
        setResumeError(failure.message);
      } else if (failure?.scope === "global") {
        toast.error(failure.message);
      } else {
        toast.error(
          isUnauthorized(error)
            ? MESSAGES.FORM_SESSION_EXPIRED
            : MESSAGES.FORM_FAILED
        );
      }
      setSubmission({ status: "idle" });
    }
  };

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
              onClick={() => goToInterview(submission.result)}
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
                <span>
                  {submission.status === "uploading"
                    ? MESSAGES.RESUME_PHASE_UPLOADING
                    : MESSAGES.RESUME_PHASE_READING}
                </span>
                {submission.status === "uploading" ? (
                  <span className="tabular-nums">{submission.percent}%</span>
                ) : null}
              </div>
              <Progress
                value={submission.status === "uploading" ? submission.percent : null}
                className={
                  submission.status === "reading"
                    ? "animate-pulse motion-reduce:animate-none"
                    : undefined
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
