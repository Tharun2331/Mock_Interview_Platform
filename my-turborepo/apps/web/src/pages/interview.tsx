import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import {
  MicIcon,
  MicOffIcon,
  AlertTriangleIcon,
  PhoneOffIcon,
  ArrowDownIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { PresenceOrb } from "@/components/PresenceOrb";
import { useInterview, type InterviewState } from "@/hooks/useInterview";
import { MESSAGES } from "@/lib/messages";
import { cn } from "@/lib/utils";

// The live interview screen.
//
// Visual direction is the dark cinematic tone from
// docs/design/references/elevenlabs-design.md, sitting on the surface ladder
// from linear-design.md. Its controls come from ADR-0005: the conversation is
// continuous and interruptible, so there are no turns to advance and no
// question to pause — only one control that always works, which is to stop.
//
// Everything here renders from the state union. Nothing renders from a pair of
// booleans, which is how a screen ends up claiming to record and process at
// once.

const FIVE_MINUTES_MS = 5 * 60 * 1000;

// mm:ss. Rounded up so the counter reads "1:00" for the whole final minute
// rather than sitting on "0:00" while time remains.
function formatRemaining(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

type StatusPresentation = {
  label: string;
  // A --state-* token. The same value colours the status text and the orb, so
  // the two can never disagree about what the system is doing.
  hue: string;
};

// What the candidate must know instantly, per state. Every one carries a label
// as well as a colour: colour is never the only channel.
function statusFor(state: InterviewState): StatusPresentation {
  switch (state.status) {
    case "requesting-permission":
      return {
        label: MESSAGES.INTERVIEW_MIC_PREPARING,
        hue: "var(--state-processing)",
      };
    case "connecting":
      return {
        label: MESSAGES.INTERVIEW_CONNECTING,
        hue: "var(--state-processing)",
      };
    case "recording":
      return {
        label: MESSAGES.INTERVIEW_LISTENING,
        hue: "var(--state-recording)",
      };
    case "processing":
      // Achromatic on purpose. A wait is not an event, and colouring it would
      // put it in competition with the states that are.
      return {
        label: MESSAGES.INTERVIEW_THINKING,
        hue: "var(--state-processing)",
      };
    case "interviewer-speaking":
      return {
        label: MESSAGES.INTERVIEW_SPEAKING,
        hue: "var(--state-speaking)",
      };
    case "interrupting":
      return {
        label: MESSAGES.INTERVIEW_INTERRUPTING,
        hue: "var(--state-recording)",
      };
    default:
      return { label: "", hue: "var(--state-processing)" };
  }
}

// Driven by measured amplitude, never by a state flag. A meter that animated
// from state would happily pulse while the microphone is muted at OS level,
// which is worse than no meter because it actively lies.
function LevelMeter({
  level,
  active,
  hue,
}: {
  level: number;
  active: boolean;
  // Whose voice the bars are reading. Colouring the meter with the state hue is
  // what stops it being mistaken for the microphone while the interviewer is
  // the one making the sound.
  hue: string;
}) {
  const bars = 32;
  return (
    <div
      className="flex h-8 items-center gap-[3px]"
      // The state is already announced through the live region and printed in
      // the status line; the bars are a third channel on top of both.
      aria-hidden
    >
      {Array.from({ length: bars }, (_, index) => {
        // A fixed envelope so the bars differ in height without re-rendering
        // into a new shape every frame.
        const weight = 0.3 + 0.7 * Math.sin((index / (bars - 1)) * Math.PI);
        const height = active ? Math.max(2, level * 32 * weight) : 2;
        return (
          <span
            key={index}
            className="w-[3px] rounded-full transition-[height] duration-75 motion-reduce:transition-none"
            style={{
              height: `${height}px`,
              backgroundColor: active ? hue : "var(--hairline-strong)",
            }}
          />
        );
      })}
    </div>
  );
}

// A screen of its own rather than a toast, in the product's own voice. Every
// non-running state gets one of these, because each is a real place a candidate
// can land and needs a way out of.
function Interstitial({
  icon,
  title,
  body,
  children,
}: {
  icon?: React.ReactNode;
  title?: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-1 flex-col items-center justify-center gap-6 px-4 text-center">
      {icon}
      <div className="flex max-w-sm flex-col gap-3">
        {title !== undefined ? (
          <h2 className="font-display text-3xl text-ink">{title}</h2>
        ) : null}
        <p className="text-sm leading-relaxed text-ink-muted">{body}</p>
      </div>
      <div className="flex flex-col items-center gap-2">{children}</div>
    </section>
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

  const {
    state,
    transcript,
    level,
    outputLevel,
    micOpen,
    remainingMs,
    start,
    stop,
  } = useInterview(sessionId ?? "");

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follows new rows only while the reader is already at the bottom. Someone
  // who scrolled up to re-read an earlier answer must not be yanked away by an
  // incoming partial — they get the jump control below instead.
  useEffect(() => {
    if (!pinned) return;
    const node = scrollRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [transcript, pinned]);

  if (sessionId === null) {
    return (
      <div className="flex h-full flex-col">
        <Interstitial
          icon={
            <AlertTriangleIcon className="size-5 text-ink-subtle" aria-hidden />
          }
          body={MESSAGES.INTERVIEW_NO_SESSION}
        >
          <Button className="cursor-pointer" onClick={() => void navigate("/form")}>
            {MESSAGES.INTERVIEW_BACK}
          </Button>
        </Interstitial>
      </div>
    );
  }

  const status = statusFor(state);
  const listening = state.status === "recording" || state.status === "interrupting";
  const speaking = state.status === "interviewer-speaking";

  // Whichever voice currently holds the floor. Both readings are measured off
  // an analyser — the candidate's from the microphone, the interviewer's from
  // the playback bus — so the orb and the meter are never animating from a
  // state flag. If the audio stalls mid-sentence they go still, which is the
  // behaviour that makes a stall visible instead of hidden.
  const activeLevel = speaking ? outputLevel : level;
  const activeVoice = listening || speaking;
  const running =
    state.status === "requesting-permission" ||
    state.status === "connecting" ||
    state.status === "recording" ||
    state.status === "processing" ||
    state.status === "interviewer-speaking" ||
    state.status === "interrupting";

  // The microphone is open while the interviewer speaks, and that condition has
  // its own colour rather than borrowing from recording or speaking. A
  // candidate who reads it as "recording" talks over the question; one who
  // reads it as "the interviewer's turn" believes they are not being heard.
  const micHue =
    state.status === "interviewer-speaking"
      ? "var(--state-listening)"
      : "var(--state-recording)";

  return (
    <div className="mx-auto flex h-full w-full max-w-3xl flex-col gap-5 p-4 sm:p-6">
      {/* Polite for ordinary state changes, so a screen reader is not
          interrupted mid-sentence. The interruption case below is assertive:
          the candidate's own voice caused it, and stale audio feedback would
          contradict what they just heard happen. */}
      <p className="sr-only" aria-live="polite">
        {status.label}
      </p>
      <p className="sr-only" aria-live="assertive">
        {state.status === "interrupting" ? MESSAGES.INTERVIEW_INTERRUPTING : ""}
      </p>

      {state.status === "idle" ? (
        <Interstitial
          icon={
            <PresenceOrb hue="var(--cue)" className="size-28 sm:size-36" />
          }
          title={MESSAGES.INTERVIEW_TITLE}
          // Explained before the browser prompt appears, not after — a
          // permission dialog with no stated reason gets dismissed.
          body={MESSAGES.INTERVIEW_MIC_EXPLAIN}
        >
          {/* Said once, up front. People default to turn-taking politeness with
              software and will never discover interruption on their own. */}
          <p className="max-w-xs text-sm text-ink-subtle">
            {MESSAGES.INTERVIEW_INTERRUPT_HINT}
          </p>
          <Button
            size="lg"
            className="mt-3 cursor-pointer"
            onClick={() => void start()}
          >
            <MicIcon aria-hidden className="size-4" />
            {MESSAGES.INTERVIEW_START}
          </Button>
        </Interstitial>
      ) : null}

      {state.status === "permission-denied" || state.status === "error" ? (
        <Interstitial
          icon={
            <AlertTriangleIcon
              className="size-5 text-destructive"
              aria-hidden
            />
          }
          // Names the browser's own control, because "allow access" without
          // saying where is not a recovery instruction.
          body={state.message}
        >
          <Button className="cursor-pointer" onClick={() => void start()}>
            {MESSAGES.INTERVIEW_RETRY}
          </Button>
        </Interstitial>
      ) : null}

      {state.status === "ended" ? (
        <Interstitial
          title={MESSAGES.INTERVIEW_ENDED}
          body={state.reason}
        >
          <Button
            variant="outline"
            className="cursor-pointer"
            onClick={() => void navigate("/form")}
          >
            {MESSAGES.INTERVIEW_BACK}
          </Button>
        </Interstitial>
      ) : null}

      {running ? (
        <>
          {/* The chrome the stage does not own: where you are in the flow, and
              whether the microphone is open. The mic indicator lives up here
              rather than beside the transcript because it must stay visible in
              every running state, and this row is the one thing on screen that
              never moves. */}
          <div className="flex items-center justify-between">
            <span className="font-mono text-[0.7rem] uppercase tracking-[0.14em] text-ink-faint">
              {MESSAGES.INTERVIEW_EYEBROW}
            </span>

            {/* Shown whenever the microphone is genuinely open — including
                while the interviewer speaks, because it is. Hiding it then
                would tell the candidate they are not being heard when they
                are, which is a privacy misrepresentation, not a tidy-up. */}
            <span className="flex items-center gap-1.5 text-xs text-ink-subtle">
              {micOpen ? (
                <>
                  <MicIcon
                    aria-hidden
                    className="size-3.5"
                    style={{ color: micHue }}
                  />
                  {MESSAGES.INTERVIEW_MIC_ON}
                </>
              ) : (
                <MicOffIcon aria-hidden className="size-3.5" />
              )}
            </span>
          </div>

          {/* The stage: clock, presence, then captions, stacked on the centre
              line with nothing framing them. The orb is the interviewer and its
              hue is the state; the meter under it is the candidate's own voice,
              measured. Read together they answer "who has the floor" without a
              legend, which is what lets the panel around them go away. */}
          {/* overflow-hidden because the bloom is wider than the column it
              sits in — without it the page picks up a horizontal scrollbar at
              narrow widths. */}
          <section className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-6 overflow-hidden">

            {/* Height is reserved so the clock's arrival does not shunt the orb
                down the screen mid-connect. Shown from the start rather than
                only when time runs short: a candidate who has to ask how long
                is left is being made to manage the app instead of the
                interview. */}
            <div className="relative flex h-24 flex-col items-center justify-end gap-1">
              {remainingMs !== null ? (
                <>
                  <span
                    className={cn(
                      "font-mono text-5xl leading-none tabular-nums transition-colors duration-500 sm:text-6xl",
                      remainingMs <= FIVE_MINUTES_MS
                        ? "text-score-mixed"
                        : "text-ink",
                    )}
                    aria-hidden
                  >
                    {formatRemaining(remainingMs)}
                  </span>
                  {/* The final stretch changes the word as well as the colour,
                      so the warning survives on a monochrome display. */}
                  <span
                    className={cn(
                      "font-mono text-[0.7rem] uppercase tracking-[0.14em]",
                      remainingMs <= FIVE_MINUTES_MS
                        ? "text-score-mixed"
                        : "text-ink-faint",
                    )}
                    aria-hidden
                  >
                    {remainingMs <= FIVE_MINUTES_MS
                      ? MESSAGES.INTERVIEW_TIME_ENDING_LABEL
                      : MESSAGES.INTERVIEW_TIME_LABEL}
                  </span>
                  {/* The split numerals read as "three four five eight" to a
                      screen reader, so the whole sentence is carried here
                      instead. */}
                  <span className="sr-only">
                    {remainingMs <= FIVE_MINUTES_MS
                      ? MESSAGES.INTERVIEW_TIME_ENDING(formatRemaining(remainingMs))
                      : MESSAGES.INTERVIEW_TIME_LEFT(formatRemaining(remainingMs))}
                  </span>
                </>
              ) : null}
            </div>

            {/* The bloom is anchored to the orb rather than to the section, so
                it stays behind the presence wherever the stack settles. Pinned
                to the section's own midpoint it drifted low, because the
                captions below the orb are taller than the clock above it. */}
            <div className="relative grid shrink-0 place-items-center">
              <div
                className="orb-atmosphere pointer-events-none absolute left-1/2 top-1/2 size-[24rem] -translate-x-1/2 -translate-y-1/2 transition-opacity duration-500 sm:size-[32rem]"
                style={{ "--orb-hue": status.hue } as React.CSSProperties}
                aria-hidden
              />
              <PresenceOrb
                hue={status.hue}
                level={activeLevel}
                responsive={activeVoice}
                className="relative size-32 sm:size-40"
              />
            </div>

            <div className="relative flex flex-col items-center gap-3">
              <p
                className="text-sm font-medium transition-colors duration-300"
                style={{ color: status.hue }}
              >
                {status.label}
              </p>
              <LevelMeter
                level={activeLevel}
                active={activeVoice}
                hue={status.hue}
              />
            </div>

            {/* Captions, not a transcript panel. No border and no fill: the
                words are the only thing here, and a box around them would put
                furniture between the candidate and what was just said. The
                mask fades the top edge so scrolled-past lines leave the frame
                rather than being cut off by a hard border. */}
            {/* Sized to its content, never flex-1. Letting the captions grow
                into the leftover height would push the whole stack to the top
                of the frame and defeat the stage's own centring — the orb has
                to sit on the centre line, not wherever the transcript leaves
                it. */}
            <div className="relative flex w-full max-w-xl flex-col">
              <div
                ref={scrollRef}
                onScroll={(event) => {
                  const node = event.currentTarget;
                  setPinned(
                    node.scrollHeight - node.scrollTop - node.clientHeight < 40,
                  );
                }}
                className="flex max-h-48 flex-col items-center gap-3 overflow-y-auto px-2 text-center [mask-image:linear-gradient(to_bottom,transparent,black_2.5rem)]"
              >
                {transcript.length === 0 ? (
                  // Not a skeleton. The length is unknown, and a skeleton of the
                  // wrong shape is worse than a sentence saying what will happen.
                  <p className="text-center text-sm text-ink-faint">
                    {MESSAGES.INTERVIEW_TRANSCRIPT_EMPTY}
                  </p>
                ) : null}

                {transcript.map((row) => (
                  // Keyed on a stable id from the stream, never the array index —
                  // an index key remounts the row on every partial and makes the
                  // list jump while it is being read.
                  <p key={row.id} className="flex flex-col items-center gap-1">
                    <span
                      className="font-mono text-[0.6rem] uppercase tracking-[0.14em]"
                      style={{
                        color:
                          row.role === "candidate"
                            ? "var(--state-recording)"
                            : "var(--state-speaking)",
                      }}
                    >
                      {row.role === "candidate"
                        ? MESSAGES.INTERVIEW_SPEAKER_YOU
                        : MESSAGES.INTERVIEW_SPEAKER_INTERVIEWER}
                    </span>
                    {/* Provisional text is dimmed and promoted when final. The
                        difference between "we think you said" and "you said"
                        should need no legend. */}
                    <span
                      className={cn(
                        "text-sm leading-relaxed",
                        row.final ? "text-ink-muted" : "text-ink-faint italic",
                      )}
                    >
                      {row.text}
                    </span>
                  </p>
                ))}
              </div>

              {/* Offered instead of yanking the reader down. Only rendered once
                  they have actually scrolled away from the live edge. */}
              {!pinned ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="absolute -bottom-2 left-1/2 -translate-x-1/2 cursor-pointer shadow-lg"
                  onClick={() => setPinned(true)}
                >
                  <ArrowDownIcon aria-hidden className="size-3.5" />
                  {MESSAGES.INTERVIEW_JUMP_LATEST}
                </Button>
              ) : null}
            </div>
          </section>

          {/* Never disabled, never behind a menu, never hidden while
              processing. A candidate who wants to stop talking and cannot is
              the worst experience this product can produce. */}
          <Button
            variant="destructive"
            className="w-full max-w-xl cursor-pointer self-center"
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
