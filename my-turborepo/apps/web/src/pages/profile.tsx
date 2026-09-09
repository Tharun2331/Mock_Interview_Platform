import { useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";
import { AlertTriangleIcon, RefreshCwIcon, ShieldCheckIcon } from "lucide-react";
import { PROFILE_LIMITS, type ProfileView } from "@repo/shared";

import { PresenceOrb } from "@/components/PresenceOrb";

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
import { DeleteAccount } from "@/components/DeleteAccount";
import { Separator } from "@/components/ui/separator";
import { useProfile } from "@/lib/profile";
import {
  saveGithub,
  saveProfileDetails,
  uploadResume,
  UnexpectedResponseError,
} from "@/lib/profileApi";
import { serverFailure, transportMessage } from "@/lib/httpErrors";
import { MESSAGES, redactionSummary, resumeThinDetail } from "@/lib/messages";

// The candidate's material, captured once. Every interview reads from here, so
// this screen is onboarding on a first visit and an edit form afterwards — the
// same fields either way, with the framing changed rather than the form.
//
// Only two of the phases below are observable from the browser. The upload has
// real bytes-sent progress; everything the server then does — extracting text,
// scanning it for personal details, storing both — is one opaque wait. It is
// named for what is actually happening rather than split into invented steps
// with fake progress behind them.
type Save =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "uploading"; percent: number }
  | { status: "processing" }
  // The PDF parsed but yielded almost nothing — a scanned or image-only resume.
  // A result to show, not an error: the profile saved, and the candidate decides
  // whether that is good enough or worth re-attaching a better file.
  | { status: "thin"; characters: number };

// This page is deliberately mounted OUTSIDE RequireProfile — it is where that
// guard sends people, so it cannot sit behind it. That means it owns the
// loading and error branches itself rather than inheriting them.
export function Profile() {
  const state = useProfile();

  if (state.status === "loading") {
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

  // Never rendered as an empty form. Showing blank fields on a failed fetch
  // would invite a returning candidate to retype a profile they already have,
  // and saving it would bump profileVersion and throw away their cached plan.
  if (state.status === "error") {
    return (
      <div className="flex min-h-full w-full flex-col items-center justify-center gap-4 px-4 py-20 text-center">
        <p className="font-display text-xl">{MESSAGES.PROFILE_LOAD_TITLE}</p>
        <p className="max-w-sm text-sm text-ink-subtle">{state.message}</p>
        <Button variant="outline" className="cursor-pointer" onClick={state.reload}>
          <RefreshCwIcon aria-hidden className="size-4" />
          {MESSAGES.RETRY}
        </Button>
      </div>
    );
  }

  // Keyed on the loaded profile so the form's initial state is seeded from real
  // values. Without the key, the fields would mount empty during the fetch and
  // keep those empties after it resolves.
  return (
    <ProfileForm
      key={state.profile?.profileVersion ?? "new"}
      existing={state.profile}
      setProfile={state.setProfile}
      clearProfile={state.clear}
    />
  );
}

function ProfileForm({
  existing,
  setProfile,
  clearProfile,
}: {
  existing: ProfileView | null;
  setProfile: (profile: ProfileView) => void;
  clearProfile: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();

  const isOnboarding = existing === null || !existing.complete;

  const [username, setUsername] = useState(existing?.username ?? "");
  const [firstName, setFirstName] = useState(existing?.firstName ?? "");
  const [lastName, setLastName] = useState(existing?.lastName ?? "");
  const [gitHub, setGitHub] = useState(
    existing?.githubUsername === undefined
      ? ""
      : `https://github.com/${existing.githubUsername}`
  );
  const [resume, setResume] = useState<File | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [save, setSave] = useState<Save>({ status: "idle" });
  const [redaction, setRedaction] = useState<{
    count: number;
    types: string[];
  } | null>(null);

  const isBusy = save.status !== "idle" && save.status !== "thin";

  // Where to go once the profile is good enough to interview with. The guard
  // records the path it interrupted, so finishing onboarding continues to where
  // the candidate was actually headed instead of dumping them on a default.
  const continueTo = (): string => {
    const from = (location.state as { from?: string } | null)?.from;
    return typeof from === "string" && from !== "/profile" ? from : "/start";
  };

  const requireText = (value: string, key: string, message: string): boolean => {
    if (value.trim().length === 0) {
      setFieldErrors((prev) => ({ ...prev, [key]: message }));
      return false;
    }
    return true;
  };

  const handleSubmit = async () => {
    setFieldErrors({});

    // Checked together so someone with three empty fields is told about all
    // three at once, rather than fixing one and being sent back for the next.
    const named =
      [
        requireText(firstName, "firstName", MESSAGES.PROFILE_FIRST_REQUIRED),
        requireText(lastName, "lastName", MESSAGES.PROFILE_LAST_REQUIRED),
        requireText(username, "username", MESSAGES.PROFILE_USERNAME_REQUIRED),
      ].every(Boolean);
    if (!named) return;

    // The resume is only mandatory the first time. A returning candidate
    // editing their name should not have to re-attach a file the server
    // already has — and re-uploading would bump profileVersion and discard a
    // cached plan for nothing.
    if (resume === null && (existing === null || !existing.hasResume)) {
      setResumeError(MESSAGES.RESUME_MISSING);
      return;
    }

    setResumeError(null);
    setRedaction(null);

    try {
      setSave({ status: "saving" });
      let updated = await saveProfileDetails({
        username: username.trim(),
        firstName: firstName.trim(),
        lastName: lastName.trim(),
      });

      if (resume !== null) {
        setSave({ status: "uploading", percent: 0 });
        const result = await uploadResume({
          file: resume,
          gitHub: gitHub.trim().length > 0 ? gitHub.trim() : null,
          onProgress: (percent) =>
            setSave(
              percent >= 100
                ? { status: "processing" }
                : { status: "uploading", percent }
            ),
        });
        updated = result.profile;
        setRedaction({
          count: result.resume.redactedCount,
          types: result.resume.redactedTypes,
        });

        if (!result.resume.usable) {
          setProfile(updated);
          setSave({ status: "thin", characters: result.resume.characters });
          return;
        }
      } else if (gitHubChanged()) {
        // No new file, but the GitHub connection moved. Its own request,
        // because the resume route requires a file.
        setSave({ status: "saving" });
        updated = await saveGithub(
          gitHub.trim().length > 0 ? gitHub.trim() : null
        );
      }

      setProfile(updated);
      setSave({ status: "idle" });
      toast.success(MESSAGES.PROFILE_SAVED);

      if (isOnboarding && updated.complete) {
        navigate(continueTo(), { replace: true });
      }
    } catch (error) {
      setSave({ status: "idle" });

      if (error instanceof UnexpectedResponseError) {
        toast.error(MESSAGES.FORM_UNEXPECTED_RESPONSE);
        return;
      }

      const failure = serverFailure(error);
      if (failure?.scope === "field") {
        setResumeError(failure.message);
        return;
      }
      // Includes the 503 the server returns when the personal-details scan
      // cannot run. That path fails closed — nothing was stored — so the copy
      // must not imply the file was at fault.
      toast.error(
        failure?.message ?? transportMessage(error, MESSAGES.PROFILE_SAVE_FAILED)
      );
    }
  };

  const gitHubChanged = (): boolean => {
    const current =
      existing?.githubUsername === undefined
        ? ""
        : `https://github.com/${existing.githubUsername}`;
    return gitHub.trim() !== current.trim();
  };

  if (save.status === "thin") {
    return (
      <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 font-display text-2xl">
              <AlertTriangleIcon
                aria-hidden
                className="size-4 shrink-0 text-score-mixed"
              />
              {MESSAGES.RESUME_THIN_TITLE}
            </CardTitle>
            <CardDescription>
              {resumeThinDetail(save.characters)}
            </CardDescription>
          </CardHeader>
          <CardFooter className="mt-2 flex-col gap-2">
            <Button
              className="w-full cursor-pointer"
              onClick={() => navigate(continueTo(), { replace: true })}
            >
              {MESSAGES.RESUME_CONTINUE_ANYWAY}
            </Button>
            <Button
              variant="ghost"
              className="w-full cursor-pointer text-ink-subtle hover:text-ink"
              onClick={() => {
                setResume(null);
                setSave({ status: "idle" });
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
    <div className="flex min-h-full w-full items-center justify-center p-4 py-10">
      <Card className="w-full max-w-md">
        <CardHeader>
          <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
            {isOnboarding
              ? MESSAGES.PROFILE_EYEBROW_FIRST
              : MESSAGES.PROFILE_EYEBROW_EDIT}
          </span>
          <CardTitle className="font-display text-3xl">
            {isOnboarding ? MESSAGES.PROFILE_TITLE_FIRST : MESSAGES.PROFILE_TITLE_EDIT}
          </CardTitle>
          <CardDescription className="leading-relaxed">
            {isOnboarding
              ? MESSAGES.PROFILE_DESCRIPTION_FIRST
              : MESSAGES.PROFILE_DESCRIPTION_EDIT}
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3">
            <NameField
              id="firstName"
              label={MESSAGES.PROFILE_FIRST_LABEL}
              value={firstName}
              error={fieldErrors.firstName}
              disabled={isBusy}
              onChange={setFirstName}
            />
            <NameField
              id="lastName"
              label={MESSAGES.PROFILE_LAST_LABEL}
              value={lastName}
              error={fieldErrors.lastName}
              disabled={isBusy}
              onChange={setLastName}
            />
          </div>

          <NameField
            id="username"
            label={MESSAGES.PROFILE_USERNAME_LABEL}
            hint={MESSAGES.PROFILE_USERNAME_HINT}
            value={username}
            error={fieldErrors.username}
            disabled={isBusy}
            onChange={setUsername}
          />

          <div className="flex flex-col gap-2">
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

            {/* A resume already on file, and no new one attached. Says so
                rather than showing an empty picker that reads as "nothing
                saved" to someone who saved one last week. */}
            {resume === null && existing?.hasResume === true ? (
              <p className="text-xs text-ink-subtle">
                {MESSAGES.PROFILE_RESUME_ON_FILE}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="github">{MESSAGES.FORM_GITHUB_LABEL}</Label>
              <span className="rounded-full border border-hairline px-2 py-0.5 text-[0.7rem] text-ink-faint">
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
            <p id="github-hint" className="text-xs text-ink-subtle">
              {MESSAGES.FORM_GITHUB_HINT}
            </p>
          </div>

          {/* The one thing a candidate handing over a resume most deserves to
              be told, and it is only honest because the server actually does
              it. Counts and categories only — naming the values back would
              undo the removal. */}
          {redaction !== null ? (
            <p
              className="flex items-start gap-2 rounded-md border border-hairline bg-surface-2 px-3 py-2 text-xs text-ink-subtle"
              role="status"
            >
              <ShieldCheckIcon
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-score-strong"
              />
              {redactionSummary(redaction.count)}
            </p>
          ) : null}

          {/* Hidden during onboarding. There is nothing to delete before the
              first save, and offering it beside the form someone is still
              filling in makes the destructive action a peer of "Save". Once a
              profile exists it becomes the last thing on the page, below a
              separator, which is where it belongs and where it will not be hit
              on the way to anything else. */}
          {existing !== null ? (
            <>
              <Separator className="mt-2" />
              <DeleteAccount onDeleted={clearProfile} />
            </>
          ) : null}
        </CardContent>

        <CardFooter className="mt-6 flex-col gap-3">
          {isBusy ? (
            <div className="w-full space-y-2" aria-live="polite">
              <div className="flex items-center justify-between font-mono text-xs text-ink-subtle">
                <span>
                  {save.status === "uploading"
                    ? MESSAGES.RESUME_PHASE_UPLOADING
                    : save.status === "processing"
                      ? MESSAGES.RESUME_PHASE_SCANNING
                      : MESSAGES.PROFILE_PHASE_SAVING}
                </span>
                {save.status === "uploading" ? (
                  <span className="tabular-nums">{save.percent}%</span>
                ) : null}
              </div>
              <Progress
                value={save.status === "uploading" ? save.percent : null}
                className={
                  save.status === "uploading"
                    ? undefined
                    : "animate-pulse motion-reduce:animate-none"
                }
              />
            </div>
          ) : null}

          <Button
            size="lg"
            className="w-full cursor-pointer"
            onClick={handleSubmit}
            disabled={isBusy}
          >
            {isBusy
              ? MESSAGES.PROFILE_SUBMIT_PENDING
              : isOnboarding
                ? MESSAGES.PROFILE_SUBMIT_FIRST
                : MESSAGES.PROFILE_SUBMIT_EDIT}
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}

type NameFieldProps = {
  id: string;
  label: string;
  hint?: string;
  value: string;
  error?: string;
  disabled: boolean;
  onChange: (value: string) => void;
};

function NameField({
  id,
  label,
  hint,
  value,
  error,
  disabled,
  onChange,
}: NameFieldProps) {
  const describedBy = `${id}-hint`;

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        disabled={disabled}
        maxLength={PROFILE_LIMITS.MAX_NAME}
        aria-invalid={error !== undefined}
        aria-describedby={error !== undefined || hint !== undefined ? describedBy : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error !== undefined || hint !== undefined ? (
        <p
          id={describedBy}
          className={
            error !== undefined
              ? "text-xs text-destructive"
              : "text-xs text-ink-subtle"
          }
        >
          {error ?? hint}
        </p>
      ) : null}
    </div>
  );
}
