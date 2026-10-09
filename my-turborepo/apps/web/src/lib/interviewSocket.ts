import { fetchMe } from "@/lib/authApi";
import { BACKEND_URL } from "@/lib/config";

// Client for the interview WebSocket.
//
// Wire protocol, matching apps/servers/routes/interview.ts:
//   - BINARY frames are raw PCM. Outbound 16 kHz from the capture worklet,
//     inbound 24 kHz for playback.
//   - TEXT frames are JSON control and transcript events.

export type InterviewServerEvent =
  | {
      type: "ready";
      sessionId: string;
      targetRole: string | null;
      // Sent so the client can show a countdown. The candidate having to ask
      // "what is the time left for the interview to end" mid-session is a UI
      // failure, not a question they should ever need to voice.
      targetMinutes: number;
    }
  | { type: "transcript"; role: string; text: string; final: boolean }
  | { type: "candidateFinished" }
  | { type: "interviewerStarted" }
  | { type: "interrupted" }
  | { type: "turnEnded" }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

// Narrowed rather than trusted. The socket is authenticated, but a shape
// mismatch after a server deploy should surface here instead of as an
// undefined three components up.
function parseServerEvent(raw: string): InterviewServerEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    return null;
  }
  const type = (parsed as { type: unknown }).type;
  return typeof type === "string" ? (parsed as InterviewServerEvent) : null;
}

export type InterviewSocketArgs = {
  sessionId: string;
  onEvent: (event: InterviewServerEvent) => void;
  onAudio: (pcm: ArrayBuffer) => void;
  onClose: (reason: string) => void;
};

export type InterviewSocket = {
  sendAudio: (frame: ArrayBuffer) => void;
  stop: () => void;
  close: () => void;
};

export async function openInterviewSocket(
  args: InterviewSocketArgs,
): Promise<InterviewSocket> {
  // The handshake authenticates with the access-token cookie, which the
  // browser attaches by itself (ADR-0011). A handshake cannot be refreshed and
  // replayed the way an API call can — and a refused one arrives as a bare
  // dropped connection, indistinguishable from the network failing — so the
  // session is confirmed first: /auth/me renews a lapsed access token on the
  // way, and rejects if the session is over.
  await fetchMe();

  const url = new URL(BACKEND_URL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/api/v1/interview";
  url.searchParams.set("sessionId", args.sessionId);

  // No token in the URL or a subprotocol: the cookie is the credential, and
  // page script never holds it.
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Interview connection failed")),
      { once: true },
    );
  });

  socket.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.data instanceof ArrayBuffer) {
      args.onAudio(event.data);
      return;
    }
    if (typeof event.data === "string") {
      const parsed = parseServerEvent(event.data);
      if (parsed !== null) args.onEvent(parsed);
    }
  });

  // No automatic reconnection, on purpose. Reconnecting starts a brand-new
  // model stream with no memory of the conversation, so the interviewer would
  // silently repeat itself while the candidate wonders what happened — and a
  // reconnect racing a half-closed stream can leave two billable streams open.
  // A drop is surfaced to the user instead.
  socket.addEventListener("close", (event: CloseEvent) =>
    args.onClose(event.reason),
  );

  return {
    sendAudio: (frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(frame);
    },
    stop: () => {
      if (socket.readyState === WebSocket.OPEN) socket.send("stop");
    },
    close: () => socket.close(),
  };
}
