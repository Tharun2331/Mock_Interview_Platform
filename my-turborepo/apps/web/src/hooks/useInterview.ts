import { useCallback, useEffect, useRef, useState } from "react";
import { AUDIO } from "@/lib/audioConstants";
import { startCapture, type CaptureHandle } from "@/lib/audio/capture";
import { InterviewerVoice } from "@/lib/audio/playback";
import {
  openInterviewSocket,
  type InterviewServerEvent,
  type InterviewSocket,
} from "@/lib/interviewSocket";
import { MESSAGES } from "@/lib/messages";

// The interview state machine.
//
// A discriminated union, never independent booleans. `isRecording && !isLoading`
// is how a UI ends up claiming to record and process at once, and on this
// screen a contradictory indicator is worse than a missing one — the candidate
// stops answering and starts debugging the app.
export type InterviewState =
  | { status: "idle" }
  | { status: "requesting-permission" }
  | { status: "permission-denied"; message: string }
  | { status: "connecting" }
  // The candidate has the floor.
  | { status: "recording" }
  // They stopped; the interviewer has not started. The gap sits entirely here.
  | { status: "processing" }
  // Interviewer audio is playing. The microphone is still open.
  | { status: "interviewer-speaking" }
  // Entered by the candidate's own voice cutting the interviewer off, which
  // makes it the only transition with no trigger in the UI.
  | { status: "interrupting" }
  | { status: "ended"; reason: string }
  | { status: "error"; message: string };

export type TranscriptRow = {
  id: string;
  role: "candidate" | "interviewer";
  text: string;
  final: boolean;
};

// getUserMedia rejects with a DOMException whose *name* carries the cause. The
// message differs across browsers, so the name is what maps to recovery copy.
function permissionMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return MESSAGES.MIC_BLOCKED;
    case "NotFoundError":
    case "OverconstrainedError":
      return MESSAGES.MIC_NOT_FOUND;
    case "NotReadableError":
      return MESSAGES.MIC_IN_USE;
    default:
      return MESSAGES.MIC_FAILED;
  }
}

export function useInterview(sessionId: string) {
  const [state, setState] = useState<InterviewState>({ status: "idle" });
  const [transcript, setTranscript] = useState<TranscriptRow[]>([]);
  const [level, setLevel] = useState(0);

  const captureRef = useRef<CaptureHandle | null>(null);
  const socketRef = useRef<InterviewSocket | null>(null);
  const voiceRef = useRef<InterviewerVoice | null>(null);
  // Read inside callbacks that must not re-subscribe on every state change.
  const statusRef = useRef<InterviewState["status"]>("idle");
  statusRef.current = state.status;

  const teardown = useCallback(() => {
    captureRef.current?.stop();
    captureRef.current = null;
    socketRef.current?.close();
    socketRef.current = null;
    voiceRef.current?.close();
    voiceRef.current = null;
  }, []);

  // Every unmount path releases the microphone and the socket. The server ends
  // its Sonic stream when the socket closes, and that stream bills by open
  // duration — so a navigation away must not leave it running.
  useEffect(() => teardown, [teardown]);

  const appendTranscript = useCallback((event: InterviewServerEvent) => {
    if (event.type !== "transcript") return;
    const role = event.role === "USER" ? "candidate" : "interviewer";

    setTranscript((rows) => {
      const last = rows[rows.length - 1];
      // A non-final row from the same speaker is replaced in place rather than
      // appended. Keying on a stable id — not the array index — is what stops
      // the row remounting and the list jumping on every partial.
      if (last !== undefined && last.role === role && !last.final) {
        const updated = [...rows];
        updated[rows.length - 1] = {
          ...last,
          text: event.text,
          final: event.final,
        };
        return updated;
      }
      return [
        ...rows,
        {
          id: `${role}-${rows.length}-${Date.now()}`,
          role,
          text: event.text,
          final: event.final,
        },
      ];
    });
  }, []);

  const handleEvent = useCallback(
    (event: InterviewServerEvent) => {
      switch (event.type) {
        case "ready":
          setState({ status: "recording" });
          break;

        case "transcript":
          appendTranscript(event);
          break;

        case "candidateFinished":
          // Only from a state where they held the floor. A late-arriving
          // transcript must not drag the UI back out of "interviewer speaking"
          // — the ASR FINAL and the interviewer's first audio can race.
          if (
            statusRef.current === "recording" ||
            statusRef.current === "interrupting"
          ) {
            setState({ status: "processing" });
          }
          break;

        case "interviewerStarted":
          setState({ status: "interviewer-speaking" });
          break;

        case "interrupted":
          // The candidate talked over the interviewer. Playback is dropped
          // immediately, including audio already scheduled but not yet heard —
          // Sonic runs ahead of real time, so without this the interviewer
          // keeps talking over someone who already took the floor.
          voiceRef.current?.interrupt();
          setState({ status: "interrupting" });
          break;

        case "turnEnded":
          // Only meaningful if nothing is still playing; the audio may outlast
          // the event that describes it.
          if (voiceRef.current?.isPlaying !== true) {
            setState({ status: "recording" });
          }
          break;

        case "closed":
          setState({ status: "ended", reason: event.reason });
          teardown();
          break;

        case "error":
          setState({ status: "error", message: event.message });
          break;
      }
    },
    [appendTranscript, teardown]
  );

  const start = useCallback(async () => {
    if (statusRef.current !== "idle" && statusRef.current !== "error") return;

    setState({ status: "requesting-permission" });

    let capture: CaptureHandle;
    try {
      capture = await startCapture({
        onFrame: (frame) => socketRef.current?.sendAudio(frame),
      });
    } catch (error) {
      setState({ status: "permission-denied", message: permissionMessage(error) });
      return;
    }
    captureRef.current = capture;

    setState({ status: "connecting" });

    const voice = new InterviewerVoice();
    // Resumed here because start() runs from a click. An AudioContext created
    // without a user gesture stays suspended and plays nothing, silently.
    await voice.resume();
    voice.onEnded = () => {
      // Back to the candidate once the audio truly finishes, not when the
      // event describing it arrived.
      if (statusRef.current === "interviewer-speaking") {
        setState({ status: "recording" });
      }
    };
    voiceRef.current = voice;

    try {
      socketRef.current = await openInterviewSocket({
        sessionId,
        onEvent: handleEvent,
        onAudio: (pcm) => voice.enqueue(pcm),
        onClose: (reason) => {
          // The socket closing after a graceful shutdown is expected — the
          // server already sent a `closed` event carrying the real reason, and
          // overwriting it here replaced a specific explanation ("idle
          // timeout", "interview complete") with the generic disconnect copy.
          // Only the unexplained case should claim the connection dropped.
          setState((current) =>
            current.status === "ended"
              ? current
              : {
                  status: "ended",
                  reason: reason || MESSAGES.INTERVIEW_DISCONNECTED,
                }
          );
          teardown();
        },
      });
    } catch {
      capture.stop();
      captureRef.current = null;
      setState({ status: "error", message: MESSAGES.INTERVIEW_CONNECT_FAILED });
    }
  }, [handleEvent, sessionId, teardown]);

  // Always available, in every state where anything is open. A candidate who
  // wants to stop talking and cannot is the worst thing this product can do.
  const stop = useCallback(() => {
    socketRef.current?.stop();
    voiceRef.current?.interrupt();
    teardown();
    setState({ status: "ended", reason: MESSAGES.INTERVIEW_ENDED_BY_YOU });
  }, [teardown]);

  // Measured amplitude, polled from the analyser. Not derived from state: an
  // indicator driven by a flag will happily pulse while the microphone is muted
  // at OS level, which is worse than showing nothing because it lies.
  useEffect(() => {
    if (captureRef.current === null) return;
    const timer = setInterval(() => {
      setLevel(captureRef.current?.readLevel() ?? 0);
    }, AUDIO.LEVEL_POLL_MS);
    return () => clearInterval(timer);
  }, [state.status]);

  // True whenever the microphone is genuinely open — including while the
  // interviewer is speaking, because it is. Hiding it then would tell the
  // candidate they are not being heard when they are.
  const micOpen =
    state.status === "recording" ||
    state.status === "interviewer-speaking" ||
    state.status === "interrupting";

  return { state, transcript, level, micOpen, start, stop };
}
