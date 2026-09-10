import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

// AudioWorklet does not exist in happy-dom, and neither does AudioContext or
// WebSocket in any useful form. The skill's rule applies: stub the worklet
// boundary and drive the hook with injected events rather than running real
// audio. Resampling correctness is a manual check, not a unit test.
//
// All three mocks are installed BEFORE the hook is imported, because the hook
// captures these bindings at module scope.

type Frame = Int16Array;

let captureLevel = 0;
const captureStop = mock(() => {});
const startCapture = mock(async (_args: { onFrame: (frame: Frame) => void }) => ({
  stop: captureStop,
  readLevel: () => captureLevel,
}));

let voicePlaying = false;
let voiceLevel = 0;
const voiceInterrupt = mock(() => {});
const voiceClose = mock(() => {});
const voiceEnqueue = mock((_pcm: ArrayBuffer) => {});

class FakeInterviewerVoice {
  onEnded: (() => void) | null = null;
  interrupt = voiceInterrupt;
  close = voiceClose;
  enqueue = voiceEnqueue;
  resume = async () => {};
  readLevel = () => voiceLevel;
  get isPlaying() {
    return voicePlaying;
  }
}

// Captured so tests can push server events into the hook the way the socket
// would, and assert on what the hook sent back.
type ServerEvent = Record<string, unknown>;
let emit: (event: ServerEvent) => void = () => {};
let emitClose: (reason: string) => void = () => {};
const socketStop = mock(() => {});
const socketClose = mock(() => {});
const sendAudio = mock((_frame: Frame) => {});
let openShouldReject = false;

const openInterviewSocket = mock(
  async (args: {
    onEvent: (event: ServerEvent) => void;
    onClose: (reason: string) => void;
  }) => {
    if (openShouldReject) throw new Error("handshake rejected");
    emit = args.onEvent;
    emitClose = args.onClose;
    return { stop: socketStop, close: socketClose, sendAudio };
  }
);

mock.module("@/lib/audio/capture", () => ({ startCapture }));
mock.module("@/lib/audio/playback", () => ({
  InterviewerVoice: FakeInterviewerVoice,
}));
mock.module("@/lib/interviewSocket", () => ({ openInterviewSocket }));

const { useInterview } = await import("@/hooks/useInterview");
const { MESSAGES } = await import("@/lib/messages");

// Drives the hook to a live interview: permission granted, socket open, the
// server's `ready` event delivered. Most tests start from here.
async function startInterview() {
  const view = renderHook(() => useInterview("session-1"));

  await act(async () => {
    await view.result.current.start();
  });

  await act(async () => {
    emit({ type: "ready", targetMinutes: 30 });
  });

  return view;
}

beforeEach(() => {
  captureLevel = 0;
  voiceLevel = 0;
  voicePlaying = false;
  openShouldReject = false;
  startCapture.mockClear();
  captureStop.mockClear();
  voiceInterrupt.mockClear();
  voiceClose.mockClear();
  socketStop.mockClear();
  socketClose.mockClear();
});

afterEach(cleanup);

describe("state machine", () => {
  it("starts idle with the microphone closed", () => {
    const { result } = renderHook(() => useInterview("session-1"));

    expect(result.current.state.status).toBe("idle");
    expect(result.current.micOpen).toBe(false);
  });

  it("reaches recording once the server says it is ready", async () => {
    const { result } = await startInterview();

    expect(result.current.state.status).toBe("recording");
    expect(result.current.micOpen).toBe(true);
  });

  // The union makes contradictory states structurally impossible, but the
  // assertion is worth keeping: `status` is one value, so a refactor that
  // reintroduced independent booleans would fail here.
  it("never holds two statuses at once", async () => {
    const { result } = await startInterview();

    await act(async () => emit({ type: "candidateFinished" }));

    expect(result.current.state.status).toBe("processing");
    expect(result.current.state.status).not.toBe("recording");
  });

  it("moves to interviewer-speaking when the interviewer starts", async () => {
    const { result } = await startInterview();

    await act(async () => emit({ type: "interviewerStarted" }));

    expect(result.current.state.status).toBe("interviewer-speaking");
  });
});

// The mic is genuinely open while the interviewer speaks. Hiding that is a
// privacy misrepresentation, not merely a UX gap — this test is what stops
// someone "tidying up" the indicator.
describe("micOpen", () => {
  it("is true in recording, interviewer-speaking and interrupting", async () => {
    const { result } = await startInterview();
    expect(result.current.micOpen).toBe(true);

    await act(async () => emit({ type: "interviewerStarted" }));
    expect(result.current.state.status).toBe("interviewer-speaking");
    expect(result.current.micOpen).toBe(true);

    await act(async () => emit({ type: "interrupted" }));
    expect(result.current.state.status).toBe("interrupting");
    expect(result.current.micOpen).toBe(true);
  });

  it("is false once the interview has ended", async () => {
    const { result } = await startInterview();

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.state.status).toBe("ended");
    expect(result.current.micOpen).toBe(false);
  });

  it("is false while processing — the candidate has handed over", async () => {
    const { result } = await startInterview();

    await act(async () => emit({ type: "candidateFinished" }));

    expect(result.current.micOpen).toBe(false);
  });
});

// The transition with no trigger in the UI. It has to be reachable from
// interviewer-speaking and it has to drop already-scheduled audio.
describe("interruption", () => {
  it("drops queued playback the instant the candidate cuts in", async () => {
    const { result } = await startInterview();
    await act(async () => emit({ type: "interviewerStarted" }));

    voiceInterrupt.mockClear();
    await act(async () => emit({ type: "interrupted" }));

    // Sonic runs ahead of real time, so without this the interviewer keeps
    // talking over someone who has already taken the floor.
    expect(voiceInterrupt).toHaveBeenCalled();
    expect(result.current.state.status).toBe("interrupting");
  });

  it("is reachable from interviewer-speaking without an intermediate state", async () => {
    const { result } = await startInterview();
    await act(async () => emit({ type: "interviewerStarted" }));

    const seen: string[] = [];
    seen.push(result.current.state.status);
    await act(async () => emit({ type: "interrupted" }));
    seen.push(result.current.state.status);

    expect(seen).toEqual(["interviewer-speaking", "interrupting"]);
  });
});

// The ASR FINAL and the interviewer's first audio race on one connection.
// These two guards are what stop a late event dragging the UI backwards.
describe("event races", () => {
  it("ignores candidateFinished once the interviewer is already speaking", async () => {
    const { result } = await startInterview();
    await act(async () => emit({ type: "interviewerStarted" }));

    await act(async () => emit({ type: "candidateFinished" }));

    expect(result.current.state.status).toBe("interviewer-speaking");
  });

  it("honours candidateFinished from interrupting", async () => {
    const { result } = await startInterview();
    await act(async () => emit({ type: "interviewerStarted" }));
    await act(async () => emit({ type: "interrupted" }));

    await act(async () => emit({ type: "candidateFinished" }));

    expect(result.current.state.status).toBe("processing");
  });

  // The audio may outlast the event that describes it.
  it("does not hand the floor back while audio is still playing", async () => {
    const { result } = await startInterview();
    await act(async () => emit({ type: "interviewerStarted" }));

    voicePlaying = true;
    await act(async () => emit({ type: "turnEnded" }));

    expect(result.current.state.status).toBe("interviewer-speaking");
  });

  it("hands the floor back on turnEnded once nothing is playing", async () => {
    const { result } = await startInterview();
    await act(async () => emit({ type: "interviewerStarted" }));

    voicePlaying = false;
    await act(async () => emit({ type: "turnEnded" }));

    expect(result.current.state.status).toBe("recording");
  });

  // The server already sent a `closed` event carrying the real reason
  // ("idle timeout", "interview complete"); the socket closing afterwards is
  // expected and must not overwrite it with generic disconnect copy.
  it("keeps the server's specific end reason when the socket then closes", async () => {
    const { result } = await startInterview();

    await act(async () => emit({ type: "closed", reason: "Interview complete" }));
    await act(async () => emitClose(""));

    expect(result.current.state).toEqual({
      status: "ended",
      reason: "Interview complete",
    });
  });

  it("reports a genuine drop when the socket closes unexplained", async () => {
    const { result } = await startInterview();

    await act(async () => emitClose(""));

    expect(result.current.state.status).toBe("ended");
    if (result.current.state.status === "ended") {
      expect(result.current.state.reason).toBe(MESSAGES.INTERVIEW_DISCONNECTED);
    }
  });
});

// getUserMedia rejects with a DOMException whose *name* carries the cause; the
// message differs across browsers, so the name is what maps to recovery copy.
describe("microphone permission failures", () => {
  const CASES = [
    ["NotAllowedError", "MIC_BLOCKED"],
    ["SecurityError", "MIC_BLOCKED"],
    ["NotFoundError", "MIC_NOT_FOUND"],
    ["OverconstrainedError", "MIC_NOT_FOUND"],
    ["NotReadableError", "MIC_IN_USE"],
  ] as const;

  it.each(CASES)("maps %s to its own recovery message", async (name, key) => {
    startCapture.mockImplementationOnce(async () => {
      throw new DOMException("denied", name);
    });

    const { result } = renderHook(() => useInterview("session-1"));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toEqual({
      status: "permission-denied",
      message: MESSAGES[key],
    });
  });

  it("falls back to a generic message for an unrecognised failure", async () => {
    startCapture.mockImplementationOnce(async () => {
      throw new Error("something else entirely");
    });

    const { result } = renderHook(() => useInterview("session-1"));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state).toEqual({
      status: "permission-denied",
      message: MESSAGES.MIC_FAILED,
    });
  });

  it("releases the microphone when the socket handshake fails", async () => {
    openShouldReject = true;

    const { result } = renderHook(() => useInterview("session-1"));
    await act(async () => {
      await result.current.start();
    });

    expect(result.current.state.status).toBe("error");
    // A capture left running would hold the mic open with no interview behind it.
    expect(captureStop).toHaveBeenCalled();
  });
});

// A candidate who wants to stop talking and cannot is the worst thing this
// product can do, so stop() must work from every state where anything is open.
describe("stop", () => {
  it("ends the interview from recording", async () => {
    const { result } = await startInterview();

    await act(async () => {
      result.current.stop();
    });

    expect(result.current.state).toEqual({
      status: "ended",
      reason: MESSAGES.INTERVIEW_ENDED_BY_YOU,
    });
  });

  it("ends the interview mid-playback and silences it", async () => {
    const { result } = await startInterview();
    await act(async () => emit({ type: "interviewerStarted" }));

    voiceInterrupt.mockClear();
    await act(async () => {
      result.current.stop();
    });

    expect(result.current.state.status).toBe("ended");
    expect(voiceInterrupt).toHaveBeenCalled();
  });

  it("releases the microphone and the socket", async () => {
    const { result } = await startInterview();

    await act(async () => {
      result.current.stop();
    });

    // The server ends its Sonic stream when the socket closes, and that stream
    // bills by open duration.
    expect(captureStop).toHaveBeenCalled();
    expect(socketClose).toHaveBeenCalled();
  });
});

// Keying on a stable id, not the array index, is what stops the row remounting
// and the list jumping on every partial.
describe("transcript", () => {
  it("replaces a non-final row in place rather than appending", async () => {
    const { result } = await startInterview();

    await act(async () =>
      emit({ type: "transcript", role: "USER", text: "So we", final: false })
    );
    const firstId = result.current.transcript[0]?.id;

    await act(async () =>
      emit({ type: "transcript", role: "USER", text: "So we had a monolith", final: false })
    );

    expect(result.current.transcript).toHaveLength(1);
    expect(result.current.transcript[0]?.text).toBe("So we had a monolith");
    // Same id means React reuses the row instead of remounting it.
    expect(result.current.transcript[0]?.id).toBe(firstId);
  });

  it("starts a new row once the previous one is final", async () => {
    const { result } = await startInterview();

    await act(async () =>
      emit({ type: "transcript", role: "USER", text: "Done.", final: true })
    );
    await act(async () =>
      emit({ type: "transcript", role: "USER", text: "Next thought", final: false })
    );

    expect(result.current.transcript).toHaveLength(2);
  });

  it("starts a new row when the speaker changes", async () => {
    const { result } = await startInterview();

    await act(async () =>
      emit({ type: "transcript", role: "USER", text: "My answer", final: false })
    );
    await act(async () =>
      emit({ type: "transcript", role: "ASSISTANT", text: "Next question", final: false })
    );

    expect(result.current.transcript).toHaveLength(2);
    expect(result.current.transcript[0]?.role).toBe("candidate");
    expect(result.current.transcript[1]?.role).toBe("interviewer");
  });
});

// An indicator driven by a state flag will happily pulse while the microphone
// is muted at OS level, which is worse than showing nothing because it lies.
describe("level metering", () => {
  it("reads zero while the analyser reports silence", async () => {
    const { result } = await startInterview();

    captureLevel = 0;
    await waitFor(() => expect(result.current.level).toBe(0));
  });

  it("reflects measured amplitude rather than the state flag", async () => {
    const { result } = await startInterview();

    captureLevel = 0.62;
    await waitFor(() => expect(result.current.level).toBeCloseTo(0.62, 5));
  });

  it("tracks the interviewer's amplitude separately from the candidate's", async () => {
    const { result } = await startInterview();

    captureLevel = 0.1;
    voiceLevel = 0.8;
    await waitFor(() => expect(result.current.outputLevel).toBeCloseTo(0.8, 5));
    expect(result.current.level).toBeCloseTo(0.1, 5);
  });
});
