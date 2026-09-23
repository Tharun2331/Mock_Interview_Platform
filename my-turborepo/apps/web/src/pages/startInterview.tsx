import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { AlertTriangleIcon, CheckIcon } from "lucide-react";
import {
  GAP_LIMITS,
  INTEL_LIMITS,
  PlanResponseSchema,
  type PlanResponse,
} from "@repo/shared";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Eyebrow } from "@/components/Eyebrow";
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
  const [jobDescription, setJobDescription] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [companyNotes, setCompanyNotes] = useState("");
  const [setup, setSetup] = useState<Setup>({ status: "idle" });

  const isBusy = setup.status === "creating" || setup.status === "planning";

  // Trimmed once, and the same value is both validated and sent — a posting
  // that is only whitespace is no posting at all, and the route rejects one.
  const trimmedJd = jobDescription.trim();
  const jdTooLong = trimmedJd.length > GAP_LIMITS.MAX_JOB_DESCRIPTION_CHARS;

  // The company fields appear only once a posting exists, because the server
  // only researches a company alongside one. Rendering them any earlier would
  // offer an input that silently does nothing.
  const trimmedCompany = companyName.trim();
  const trimmedNotes = companyNotes.trim();
  const showCompanyFields = trimmedJd.length > 0;

  // Split from session creation deliberately. The session already exists by the
  // time this runs, so a failure here is retryable on its own.
  const requestPlan = async (sessionId: string) => {
    setSetup({ status: "planning", sessionId });

    try {
      const response = await api.post("/api/v1/plan", {
        sessionId,
        targetRole: targetRole.trim(),
        // Omitted entirely rather than sent empty. The route treats an absent
        // posting as "skip the Gap agent", and `""` would fail its `.min(1)`
        // and 400 the whole plan over a field nobody filled in.
        ...(trimmedJd.length > 0 ? { jobDescription: trimmedJd } : {}),
        // Both gated on the posting for the same reason the server is: without
        // one, a company name has nothing to aim the result at. Sent only when
        // they would actually be used, so the body says what will happen.
        ...(trimmedJd.length > 0 && trimmedCompany.length > 0
          ? { companyName: trimmedCompany }
          : {}),
        ...(trimmedJd.length > 0 &&
        trimmedCompany.length > 0 &&
        trimmedNotes.length > 0
          ? { companyNotes: trimmedNotes }
          : {}),
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

    // Caught here rather than by the server, so an over-long posting costs a
    // corrected paste instead of a minted session and a 400.
    if (jdTooLong) return;

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
            <h1 className="flex items-center gap-2 font-display text-3xl">
              <AlertTriangleIcon
                aria-hidden
                className="size-4 shrink-0 text-score-mixed"
              />
              {MESSAGES.PLAN_FAILED_TITLE}
            </h1>
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
    // A page, not a dialog. This used to be a bordered card centred in the
    // viewport, which is a modal gesture — it says "something is on top of
    // something else" when there is nothing behind it. The shell here is the
    // one /history, /coach and /results already use (page header, then
    // sections), so five of the six screens behind the login now share a
    // layout and only the interview screen is deliberately apart.
    //
    // `max-w-2xl` rather than the data pages' `max-w-3xl`: this is a form, and
    // a line of prose can run wider than an input should. The old `max-w-md`
    // was a login-box width holding a six-field form.
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 p-6 pb-16">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Eyebrow>{MESSAGES.START_EYEBROW}</Eyebrow>
          <h1 className="font-display text-4xl leading-[1.1] sm:text-5xl text-ink">
            {MESSAGES.START_TITLE}
          </h1>
        </div>
        <p className="max-w-xl text-sm leading-relaxed text-ink-muted">
          {MESSAGES.START_DESCRIPTION}
        </p>
      </header>

      {/* What this round will be built from, named rather than assumed.
          The material now lives a page away, so without this the candidate
          has no way to tell whether the resume being used is the one they
          meant — and the edit link is how they check.

          The one block on this page that is read-only rather than input, so it
          is the one that sits up on `surface-2` — that ladder exists to say
          "this is a different kind of thing", and a page with a single surface
          never gets to use it. */}
      {profile !== null ? (
        <section className="flex flex-col gap-2 rounded-lg border border-hairline bg-surface-2 p-5">
          <div className="flex items-center justify-between">
            <Eyebrow as="h2">{MESSAGES.START_MATERIAL_TITLE}</Eyebrow>
            <Link
              to="/profile"
              className="text-xs text-ink-subtle underline underline-offset-2 hover:text-ink"
            >
              {MESSAGES.START_MATERIAL_EDIT}
            </Link>
          </div>
          {/* No icons on these rows. A document glyph beside "Your resume" and
              a folder glyph beside a GitHub handle restate what the words
              already say, and two decorative glyphs in a four-line block is
              most of what makes it read as generated. The rows are told apart
              by their content, which is the thing worth reading. */}
          <ul className="flex flex-col gap-1 text-sm">
            <li>{MESSAGES.START_MATERIAL_RESUME}</li>
            {profile.githubUsername !== undefined ? (
              <li className="truncate">
                {profile.githubUsername}
                {/* Tabular numerals so the repo count does not shimmer. */}
                <span className="text-ink-subtle tabular-nums">
                  {" · "}
                  {profile.repoCount}
                </span>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {/* Sections are separated by a rule and the ladder's top step, with no
          heading of their own. Three inputs do not need three headings — the
          field labels already name them, and an `<Eyebrow>` above each would
          say the same word twice. Grouping here is spacing's job. */}
      <section className="flex flex-col gap-4 border-t border-hairline pt-8">
        <div className="flex flex-col gap-2">
          <Label htmlFor="role">{MESSAGES.FORM_ROLE_LABEL}</Label>

          {/* Shortcuts that fill the input rather than a separate mode. The
                input stays the single source of truth, so there is no state
                where a chip is lit and the field says something else. */}
          {/* One column until `sm`. Two columns at 375px left every preset
              truncated — "Backend Engin…", "Cloud / DevOp…" — which turns a set
              of choices into a row of guesses, and the label that gets cut is
              the one carrying the distinction. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
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
                  : null,
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
      </section>

      {/* Genuinely optional, and the interview is whole without it. Left
          open rather than behind a disclosure: a collapsed field is a
          field nobody finds, and this is the one input that changes what
          the interviewer chooses to ask about. */}
      <section className="flex flex-col gap-4 border-t border-hairline pt-8">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <Label htmlFor="job-description">{MESSAGES.START_JD_LABEL}</Label>
            <Eyebrow>{MESSAGES.START_JD_OPTIONAL}</Eyebrow>
          </div>
          <Textarea
            id="job-description"
            value={jobDescription}
            disabled={isBusy}
            rows={5}
            placeholder={MESSAGES.START_JD_PLACEHOLDER}
            aria-describedby="job-description-hint"
            aria-invalid={jdTooLong}
            className="max-h-64 resize-y"
            onChange={(e) => setJobDescription(e.target.value)}
          />
          <p
            id="job-description-hint"
            className={
              jdTooLong ? "text-xs text-destructive" : "text-xs text-ink-subtle"
            }
          >
            {jdTooLong ? MESSAGES.START_JD_TOO_LONG : MESSAGES.START_JD_HINT}
          </p>
        </div>

        {/* Revealed by the posting rather than always present. Two more
              fields on an empty form is a longer form for everyone; revealed
              here they arrive at the moment they start doing something. */}
        {showCompanyFields ? (
          <div className="flex flex-col gap-4 border-l border-hairline pl-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-baseline justify-between">
                <Label htmlFor="company">{MESSAGES.START_COMPANY_LABEL}</Label>
                <Eyebrow>{MESSAGES.START_JD_OPTIONAL}</Eyebrow>
              </div>
              <Input
                id="company"
                value={companyName}
                disabled={isBusy}
                placeholder={MESSAGES.START_COMPANY_PLACEHOLDER}
                aria-describedby="company-hint"
                maxLength={INTEL_LIMITS.MAX_COMPANY_CHARS}
                onChange={(e) => setCompanyName(e.target.value)}
              />
              <p id="company-hint" className="text-xs text-ink-subtle">
                {MESSAGES.START_COMPANY_HINT}
              </p>
            </div>

            {/* Only once a company is named — notes about nobody are notes
                  the interview has no way to attach to anything. */}
            {trimmedCompany.length > 0 ? (
              <div className="flex flex-col gap-2">
                <Label htmlFor="company-notes">
                  {MESSAGES.START_COMPANY_NOTES_LABEL}
                </Label>
                <Textarea
                  id="company-notes"
                  value={companyNotes}
                  disabled={isBusy}
                  rows={3}
                  placeholder={MESSAGES.START_COMPANY_NOTES_PLACEHOLDER}
                  aria-describedby="company-notes-hint"
                  maxLength={INTEL_LIMITS.MAX_NOTES_CHARS}
                  className="max-h-40 resize-y"
                  onChange={(e) => setCompanyNotes(e.target.value)}
                />
                <p id="company-notes-hint" className="text-xs text-ink-subtle">
                  {MESSAGES.START_COMPANY_NOTES_HINT}
                </p>
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      {/* The submit block is a section like the others rather than a card
          footer, so it sits on the same rule and the same rhythm. No `mt-6`
          patching a gap the container already owns. */}
      <div className="flex flex-col gap-3 border-t border-hairline pt-8">
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

        {/* Sized to its words rather than stretched across the column. A
            full-width button reads as "the only thing here", which was true
            inside a 448px card and is not true on a page. */}
        <Button
          size="lg"
          className="cursor-pointer self-start"
          onClick={handleSubmit}
          disabled={isBusy || jdTooLong}
        >
          {isBusy ? MESSAGES.START_SUBMIT_PENDING : MESSAGES.START_SUBMIT}
        </Button>
      </div>
    </div>
  );
}
