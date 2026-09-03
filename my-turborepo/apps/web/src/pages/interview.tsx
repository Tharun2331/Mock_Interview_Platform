import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { MicIcon, MicOffIcon, AlertTriangleIcon, PhoneOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useInterview, type InterviewState } from "@/hooks/useInterview";
import { MESSAGES } from "@/lib/messages";

// The live interview screen.
//
// Visual direction follows docs/design/references/interview-screen.png. Its
// controls do not: that mockup is turn-based ("Answer question", "Pause",
// "Question 3 / 8"), which ADR-0005 superseded. The conversation is continuous
// and interruptible now, so there are no turns to advance and no question to
// pause — only one control that always works, which is to stop.

const FIVE_MINUTES_MS = 5 * 60 * 1000;

// mm:ss. Rounded up so the counter reads "1:00" for the whole final minute
// rather than sitting on "0:00" while time remains.
function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// What the candidate must know instantly, per state. Every one carries a label
// as well as a colour: colour alone is never the channel for state.
function statusFor(state: InterviewState): { label: string; tone: string } {
  switch (state.status) {
    case "requesting-permission":
      return { label: MESSAGES.INTERVIEW_MIC_PREPARING, tone: "text-amber-400" };
    case "connecting":
      return { label: MESSAGES.INTERVIEW_CONNECTING, tone: "text-amber-400" };
    case "recording":
      return { label: MESSAGES.INTERVIEW_LISTENING, tone: "text-emerald-400" };
    case "processing":
      return { label: MESSAGES.INTERVIEW_THINKING, tone: "text-amber-400" };
    case "interviewer-speaking":
      return { label: MESSAGES.INTERVIEW_SPEAKING, tone: "text-sky-400" };
    case "interrupting":
      return { label: MESSAGES.INTERVIEW_INTERRUPTING, tone: "text-emerald-400" };
    default:
      return { label: "", tone: "text-muted-foreground" };
  }
}

// Driven by measured amplitude, never by a state flag. A meter that animates
// from state would happily pulse while the microphone is muted at OS level,
// which is worse than no meter because it actively lies.
function LevelMeter({ level, active }: { level: number; active: boolean }) {
  const bars = 24;
  return (
    <div
      className="flex h-8 items-center gap-[3px]"
      // The number is already announced through the status region; the bars are
      // decoration on top of it.
      aria-hidden
    >
      {Array.from({ length: bars }, (_, index) => {
        // A fixed pseudo-random envelope so the bars differ in height without
        // re-rendering into a new shape each frame.
        const weight = 0.35 + 0.65 * Math.sin((index / bars) * Math.PI);
        const height = active ? Math.max(2, level * 32 * weight) : 2;
        return (
          <span
            key={index}
            className={
              active
                ? "w-[3px] rounded-full bg-emerald-400 transition-[height] duration-75 motion-reduce:transition-none"
                : "w-[3px] rounded-full bg-white/15"
            }
            style={{ height: `${height}px` }}
          />
        );
      })}
    </div>
  );
}

export function Interview() {
  const navigate = useNavigate();
  const location = useLocation();

  // Passed by the plan screen. Read defensively: a direct navigation or a
  // reload has no router state, and that is a real screen rather than a crash.
  const routerState: unknown = location.state;
  const sessionId =
    typeof routerState === "object" &&
    routerState !== null &&
    "sessionId" in routerState &&
    typeof (routerState as { sessionId: unknown }).sessionId === "string"
      ? (routerState as { sessionId: string }).sessionId
      : null;

  const { state, transcript, level, micOpen, remainingMs, start, stop } =
    useInterview(sessionId ?? "");

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follows new rows only while the reader is already at the bottom. Someone
  // who scrolled up to re-read an earlier answer must not be yanked away by an
  // incoming partial.
  useEffect(() => {
    if (!pinned) return;
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [transcript, pinned]);

  if (sessionId === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
        <AlertTriangleIcon className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">
          {MESSAGES.INTERVIEW_NO_SESSION}
        </p>
        <Button className="cursor-pointer" onClick={() => void navigate("/form")}>
          {MESSAGES.INTERVIEW_BACK}
        </Button>
      </div>
    );
  }

  const status = statusFor(state);
  const listening = state.status === "recording" || state.status === "interrupting";

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-6 p-4 sm:p-6">
      {/* Polite for ordinary state changes, so a screen reader is not
          interrupted mid-sentence. The interruption case below is assertive. */}
      <p className="sr-only" aria-live="polite">
        {status.label}
      </p>
      <p className="sr-only" aria-live="assertive">
        {state.status === "interrupting" ? MESSAGES.INTERVIEW_INTERRUPTING : ""}
      </p>

      {state.status === "idle" ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
          <MicIcon className="size-8 text-muted-foreground" aria-hidden />
          <div className="flex flex-col gap-2">
            <h2 className="text-xl font-semibold">{MESSAGES.INTERVIEW_TITLE}</h2>
            {/* Explained before the browser prompt appears, not after — a
                permission dialog with no stated reason gets dismissed. */}
            <p className="max-w-sm text-sm text-muted-foreground">
              {MESSAGES.INTERVIEW_MIC_EXPLAIN}
            </p>
            {/* Said once, up front. People default to turn-taking politeness
                with software and will never discover interruption alone. */}
            <p className="max-w-sm text-sm text-muted-foreground">
              {MESSAGES.INTERVIEW_INTERRUPT_HINT}
            </p>
          </div>
          <Button className="cursor-pointer" onClick={() => void start()}>
            <MicIcon aria-hidden className="size-4" />
            {MESSAGES.INTERVIEW_START}
          </Button>
        </section>
      ) : null}

      {state.status === "permission-denied" || state.status === "error" ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <AlertTriangleIcon className="size-6 text-muted-foreground" aria-hidden />
          {/* Names the browser's own control, because "allow access" without
              saying where is not a recovery instruction. */}
          <p className="max-w-sm text-sm text-muted-foreground">{state.message}</p>
          <Button className="cursor-pointer" onClick={() => void start()}>
            {MESSAGES.INTERVIEW_RETRY}
          </Button>
        </section>
      ) : null}

      {state.status === "ended" ? (
        <section className="flex flex-1 flex-col items-center justify-center gap-4 text-center">
          <h2 className="text-lg font-semibold">{MESSAGES.INTERVIEW_ENDED}</h2>
          <p className="max-w-sm text-sm text-muted-foreground">{state.reason}</p>
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => void navigate("/form")}
          >
            {MESSAGES.INTERVIEW_BACK}
          </Button>
        </section>
      ) : null}

      {state.status === "requesting-permission" ||
      state.status === "connecting" ||
      state.status === "recording" ||
      state.status === "processing" ||
      state.status === "interviewer-speaking" ||
      state.status === "interrupting" ? (
        <>
          <section className="flex flex-col items-center gap-4 rounded-xl border bg-muted/30 py-10">
            {/* Scale tracks measured input while the candidate holds the floor,
                and a slow pulse while the interviewer speaks. Reduced motion
                collapses both to a static shape rather than removing the
                indicator. */}
            <div
              className="size-24 rounded-full bg-gradient-to-br from-sky-400 to-blue-600 shadow-[0_0_60px_-10px] shadow-sky-500/60 transition-transform duration-100 motion-reduce:transition-none motion-reduce:scale-100"
              style={{
                transform: `scale(${listening ? 1 + level * 0.35 : 1})`,
              }}
              aria-hidden
            />
            <p className={`text-sm font-medium ${status.tone}`}>{status.label}</p>
            <LevelMeter level={level} active={listening} />

            {/* Shown from the start, not only when time runs short. A candidate
                who has to ask how long is left is being made to manage the
                app instead of the interview. Turns amber inside the final
                five minutes, with the label carrying that too — colour is
                never the only channel. */}
            {remainingMs !== null ? (
              <p
                className={
                  remainingMs <= FIVE_MINUTES_MS
                    ? "text-xs tabular-nums text-amber-400"
                    : "text-xs tabular-nums text-muted-foreground"
                }
              >
                {remainingMs <= FIVE_MINUTES_MS
                  ? MESSAGES.INTERVIEW_TIME_ENDING(formatRemaining(remainingMs))
                  : MESSAGES.INTERVIEW_TIME_LEFT(formatRemaining(remainingMs))}
              </p>
            ) : null}
          </section>

          <section className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                {MESSAGES.INTERVIEW_TRANSCRIPT}
              </h3>
              {/* Shown whenever the microphone is genuinely open — including
                  while the interviewer speaks, because it is. Hiding it then
                  would tell the candidate they are not being heard when they
                  are, which is a privacy misrepresentation, not a tidy-up. */}
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {micOpen ? (
                  <MicIcon aria-hidden className="size-3.5 text-emerald-400" />
                ) : (
                  <MicOffIcon aria-hidden className="size-3.5" />
                )}
                {micOpen ? MESSAGES.INTERVIEW_MIC_ON : ""}
              </span>
            </div>

            <div
              ref={scrollRef}
              onScroll={(event) => {
                const node = event.currentTarget;
                setPinned(
                  node.scrollHeight - node.scrollTop - node.clientHeight < 40
                );
              }}
              className="flex min-h-40 flex-1 flex-col gap-3 overflow-y-auto rounded-xl border bg-muted/20 p-4"
            >
              {transcript.length === 0 ? (
                // Not a skeleton. The length is unknown, and a skeleton of the
                // wrong shape is worse than a sentence saying what will happen.
                <p className="text-sm text-muted-foreground">
                  {MESSAGES.INTERVIEW_TRANSCRIPT_EMPTY}
                </p>
              ) : null}

              {transcript.map((row) => (
                // Keyed on a stable id, never the array index — an index key
                // remounts the row on every partial and makes the list jump.
                <p key={row.id} className="flex flex-col gap-0.5">
                  <span className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">
                    {row.role === "candidate"
                      ? MESSAGES.INTERVIEW_SPEAKER_YOU
                      : MESSAGES.INTERVIEW_SPEAKER_INTERVIEWER}
                  </span>
                  {/* Provisional text is dimmed and promoted when final. The
                      difference between "we think you said" and "you said"
                      should need no legend. */}
                  <span
                    className={
                      row.final ? "text-sm" : "text-sm text-muted-foreground"
                    }
                  >
                    {row.text}
                  </span>
                </p>
              ))}
            </div>
          </section>

          {/* Never disabled, never behind a menu, never hidden while
              processing. A candidate who wants to stop talking and cannot is
              the worst experience this product can produce. */}
          <Button
            variant="destructive"
            className="w-full cursor-pointer"
            onClick={stop}
          >
            <PhoneOffIcon aria-hidden className="size-4" />
            {MESSAGES.INTERVIEW_STOP}
          </Button>
        </>
      ) : null}
    </div>
  );
}
