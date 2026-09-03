import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ExchangeBuffer,
  type CompletedExchange,
} from "../lib/exchangeBuffer";
import { INTERVIEW_TOOL_NAMES, SONIC } from "../lib/constants";
import { verifier } from "../lib/cognitoAuth";
import { SessionAccessError, SessionStateError } from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { SonicConversation } from "../lib/sonic";
import {
  finishInterview,
  recordAnswer,
  startInterview,
} from "../lib/sessions";
import {
  INTERVIEW_TOOLS,
  buildInterviewSystemPrompt,
} from "../agents/mockInterview";

// The live interview transport.
//
// Wire protocol, in both directions:
//   - BINARY frames are raw PCM audio and nothing else. Inbound is 16 kHz from
//     the browser's AudioWorklet; outbound is 24 kHz from Sonic. Audio is by
//     far the highest-frequency traffic, so it stays binary rather than being
//     base64'd into JSON — that would inflate it by a third for no benefit.
//   - TEXT frames are JSON control and transcript events.
//
// `ws` rather than socket.io: socket.io's auto-reconnect would silently open a
// second billable Sonic stream with no memory of the conversation, and its
// long-polling fallback cannot carry duplex audio at all.

const PATH = "/api/v1/interview";
// A browser WebSocket cannot set headers, so the access token rides in the
// subprotocol. Deliberately not a query parameter: those land in ALB access
// logs and browser history in plain text.
const AUTH_PROTOCOL_PREFIX = "bearer.";

export type InterviewServerEvent =
  | { type: "ready"; sessionId: string; targetRole: string | null }
  | { type: "transcript"; role: string; text: string; final: boolean }
  // The candidate stopped talking and the interviewer has not started. Derived
  // from the arrival of their FINAL ASR transcript, which is the only signal
  // Sonic gives for "speech ended". Without it the client cannot distinguish a
  // thinking pause from a dead connection, which is the moment silence is most
  // likely to read as a crash.
  | { type: "candidateFinished" }
  | { type: "interviewerStarted" }
  // Barge-in. The client must drop its queued playback the moment this lands,
  // or the interviewer keeps talking over a candidate who already interrupted.
  | { type: "interrupted" }
  | { type: "turnEnded" }
  | { type: "closed"; reason: string }
  | { type: "error"; message: string };

function sendEvent(socket: WebSocket, event: InterviewServerEvent): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
}

// `{"generationStage":"FINAL"}` vs `SPECULATIVE`. The spike showed FINAL for
// assistant text arriving 8-16 seconds after the audio it describes, so this
// flag drives emphasis in the UI, not whether the text is shown at all.
function isFinalStage(generationStage: string | null): boolean {
  return generationStage !== null && generationStage.includes("FINAL");
}

type ToolCall = { toolName: string; toolUseId: string; content: string };

// Handles a tool the interviewer invoked. Returns whatever should go back on
// the stream as the tool result.
//
// These exist to persist state and report it, never to decide what to ask —
// that reasoning happens inside Sonic as it generates the next turn.
function runTool(call: ToolCall, state: InterviewState): unknown {
  switch (call.toolName) {
    case INTERVIEW_TOOL_NAMES.LOG_EXCHANGE: {
      state.exchanges += 1;
      // TODO(persistence): write an ANSWER#<qId> item here. Buffered in memory
      // for now so the transport can be verified independently of the
      // DynamoDB write path.
      return { ok: true, exchangesLogged: state.exchanges };
    }
    case INTERVIEW_TOOL_NAMES.GET_SESSION_STATE: {
      const elapsedMs = Date.now() - state.startedAt;
      return {
        exchangesLogged: state.exchanges,
        elapsedMinutes: Math.floor(elapsedMs / 60_000),
        remainingMinutes: Math.max(
          0,
          state.targetMinutes - Math.floor(elapsedMs / 60_000)
        ),
      };
    }
    case INTERVIEW_TOOL_NAMES.END_INTERVIEW: {
      state.endRequested = true;
      return { ok: true };
    }
    default:
      // Unknown tool names are the model hallucinating one. Answering with an
      // error beats throwing: the stream survives and the interviewer moves on.
      return { ok: false, error: `Unknown tool: ${call.toolName}` };
  }
}

type InterviewState = {
  startedAt: number;
  targetMinutes: number;
  exchanges: number;
  endRequested: boolean;

  // The exchange currently being assembled.
  //
  // Built from transcript events rather than from the logExchange tool. The
  // tool is a steering signal the model may or may not emit — nothing has yet
  // confirmed it fires at all — and an answer must never depend on the model
  // remembering to report it. Transcript events are unconditional.
  //
  // Questions accumulate SPECULATIVE assistant text, not FINAL: the spike
  // measured FINAL arriving 8-16s after the audio it describes, and sometimes
  // not before the session ended. SPECULATIVE is what was actually spoken and
  // it arrives with the audio.
  buffer: ExchangeBuffer;

  // Completed exchanges, kept in memory purely to replay into a renewed Sonic
  // stream. DynamoDB is the durable copy; this is the working set the model
  // needs to keep the conversation's thread across the 8-minute ceiling.
  history: CompletedExchange[];
};

async function handleConnection(
  socket: WebSocket,
  userId: string,
  sessionId: string
): Promise<void> {
  let sonic: SonicConversation | null = null;
  let closing = false;

  // Joined lifetimes. Whatever ends first must end the other, or a closed
  // browser tab leaves a Sonic stream billing until the idle timeout.
  // Set once the interview is running, so shutdown can flush an exchange that
  // was in progress when the connection dropped.
  let flushOnClose: (() => Promise<void>) | null = null;

  const shutdown = async (reason: string): Promise<void> => {
    if (closing) return;
    closing = true;
    // Logged because the client only ever sees generic copy. When an interview
    // ends unexpectedly, this line is the difference between knowing it was an
    // idle timeout, a model-requested end, or a dropped socket, and guessing.
    console.log(`[interview] ${sessionId} closing — ${reason}`);

    // Before anything else. An abrupt disconnect is exactly the case where the
    // candidate's last answer would otherwise be lost, and it is the one they
    // are most likely to care about.
    if (flushOnClose !== null) {
      try {
        await flushOnClose();
        await finishInterview({ sessionId, status: "complete" });
      } catch (error) {
        console.error(
          `[interview] ${sessionId} close flush failed — ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    }

    if (sonic !== null) await sonic.close(reason);
    if (socket.readyState === socket.OPEN) {
      sendEvent(socket, { type: "closed", reason });
      socket.close();
    }
  };

  try {
    const meta = await startInterview({ sessionId, userId });
    const plan = meta.plan;
    if (plan === undefined) {
      sendEvent(socket, { type: "error", message: MESSAGES.SESSION_NOT_INTERVIEWABLE });
      socket.close();
      return;
    }

    const state: InterviewState = {
      startedAt: Date.now(),
      targetMinutes: plan.targetMinutes,
      exchanges: 0,
      endRequested: false,
      buffer: new ExchangeBuffer(),
      history: [],
    };

    // Flushes the exchange in progress. Awaited nowhere on the hot path — a
    // DynamoDB round trip must not sit between the candidate finishing and the
    // interviewer replying — but always awaited on the close path so a
    // disconnect does not race the final write.
    const flushExchange = async (): Promise<void> => {
      // take() rolls the buffer forward synchronously, so a second flush
      // arriving during the await cannot write the same exchange twice.
      const exchange = state.buffer.take();
      if (exchange === null) return;
      state.exchanges += 1;
      // Recorded before the write, so a renewal that happens while DynamoDB is
      // slow still replays the exchange the candidate just finished.
      state.history.push(exchange);

      try {
        await recordAnswer({
          sessionId,
          ...exchange,
          // Not yet distinguished. The plan carries a budget per type but the
          // stream does not say which one a given question came from, so
          // everything is recorded as technical until the model reports it.
          questionType: "technical",
        });
      } catch (error) {
        // Logged, never surfaced. Losing one answer is bad; ending a live
        // interview because a write failed is worse.
        console.error(
          `[interview] ${sessionId} answer write failed — ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    };

    // Tracked across events because textOutput carries neither role nor
    // generation stage — both arrive on the contentStart immediately before it,
    // and the pairing is positional.
    let lastRole = "";
    let lastFinal = false;

    sonic = new SonicConversation({
      systemPrompt: buildInterviewSystemPrompt(plan),
      tools: INTERVIEW_TOOLS,
      // Bedrock closes a stream after ~8 minutes, so a 40-minute interview
      // spans several. The conversation replays these into each replacement.
      getHistory: () => state.history,
      onRenew: (count) =>
        console.log(`[interview] ${sessionId} stream renewed (#${count})`),
      onClose: (reason) => void shutdown(reason),
      onEvent: (event) => {
        switch (event.kind) {
          case "contentStart":
            if (event.type === "TEXT") {
              lastRole = event.role;
              lastFinal = isFinalStage(event.generationStage);
              // The candidate's transcript arriving means they have stopped.
              if (event.role === "USER" && lastFinal) {
                sendEvent(socket, { type: "candidateFinished" });
              }
            }
            // Only the assistant's audio start is interesting to the client;
            // it is the cue to open the playback buffer.
            if (event.type === "AUDIO" && event.role === "ASSISTANT") {
              sendEvent(socket, { type: "interviewerStarted" });
            }
            break;

          case "textOutput":
            // Role is carried on the preceding contentStart, not here, so the
            // last seen role is tracked above.
            sendEvent(socket, {
              type: "transcript",
              role: lastRole,
              text: event.content,
              final: lastFinal,
            });

            if (lastRole === "ASSISTANT" && !lastFinal) {
              // The interviewer starting a new turn while an answer is pending
              // is what marks the previous exchange complete. This is the flush
              // trigger rather than the candidate's FINAL transcript, because
              // Sonic emits those per sentence — flushing on each would write
              // one item per sentence, splitting a single answer across several
              // records and multiplying writes by the length of the answer.
              //
              // Synchronous up to its first await, so the state reset inside it
              // happens before the append below.
              if (state.buffer.hasAnswer) void flushExchange();
              state.buffer.appendQuestion(event.content);
            } else if (lastRole === "USER" && lastFinal) {
              // Accumulated only. Sonic emits a FINAL USER transcript per
              // sentence fragment, so flushing here would split one spoken
              // answer across several records.
              state.buffer.appendAnswer(event.content);
            }
            break;

          case "audioOutput":
            // Decoded here rather than forwarding base64. The client gets raw
            // PCM it can hand straight to Web Audio.
            if (socket.readyState === socket.OPEN) {
              socket.send(Buffer.from(event.base64, "base64"));
            }
            break;

          case "toolUse": {
            // Logged because nothing has ever confirmed the model calls these
            // at all. It also makes endInterview visible: that tool is the one
            // path where the interviewer can end a session early on its own,
            // and without this line an early finish is indistinguishable from
            // a timeout or a dropped socket.
            console.log(
              `[interview] ${sessionId} toolUse ${event.toolName} ${event.content}`
            );
            const result = runTool(event, state);
            sonic?.sendToolResult(event.toolUseId, result);
            break;
          }

          case "contentEnd":
            // Scoped to AUDIO deliberately. Text blocks also end with
            // END_TURN, and forwarding those would tell the client the
            // interviewer had finished speaking while its audio was still
            // playing — the transcript and the speech are independent streams.
            if (event.type !== "AUDIO") break;
            if (event.stopReason === "INTERRUPTED") {
              // Recorded on the exchange. An answer given over a half-delivered
              // question is not comparable to one given after the whole
              // question, and the Evaluator needs to know which it is scoring.
              state.buffer.markInterrupted();
              sendEvent(socket, { type: "interrupted" });
            } else if (event.stopReason === "END_TURN") {
              sendEvent(socket, { type: "turnEnded" });
            }
            break;

          case "completionEnd":
            if (state.endRequested) void shutdown("interview complete");
            break;

          case "error":
            console.error(`[interview] ${sessionId} ${event.message}`);
            sendEvent(socket, { type: "error", message: MESSAGES.INTERVIEW_FAILED });
            break;
        }
      },
    });

    flushOnClose = flushExchange;

    await sonic.start();
    sendEvent(socket, {
      type: "ready",
      sessionId,
      targetRole: meta.role ?? null,
    });

    // Prompts the interviewer to open. Without this Sonic waits for speech and
    // the candidate has to greet a silent interviewer before anything happens.
    sonic.kickoff(MESSAGES.INTERVIEW_KICKOFF);

    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        sonic?.sendAudio(data);
        return;
      }
      // The only control message the client sends today. Stopping must always
      // be reachable, so it is handled unconditionally.
      if (data.toString() === "stop") void shutdown("candidate ended interview");
    });

    socket.on("close", () => void shutdown("client disconnected"));
    socket.on("error", () => void shutdown("socket error"));
  } catch (error) {
    if (error instanceof SessionAccessError) {
      sendEvent(socket, { type: "error", message: error.message });
    } else if (error instanceof SessionStateError) {
      sendEvent(socket, { type: "error", message: error.message });
    } else {
      console.error(
        `[interview] ${sessionId} ${error instanceof Error ? error.message : error}`
      );
      sendEvent(socket, { type: "error", message: MESSAGES.INTERVIEW_FAILED });
    }
    await shutdown("startup failed");
  }
}

export function attachInterviewSocket(server: Server): WebSocketServer {
  // noServer, so the upgrade is authenticated before a socket exists. A
  // rejected caller never reaches handleConnection and never causes a Sonic
  // stream to be allocated.
  const wss = new WebSocketServer({ noServer: true });

  // Sockets that have answered a ping since the last sweep.
  //
  // Populated in the handleUpgrade callback, NOT from a 'connection' listener.
  // With noServer, ws calls the upgrade callback *instead of* emitting
  // 'connection' — but it still adds the socket to wss.clients. A 'connection'
  // listener therefore never runs while the sweep below still sees the socket,
  // so it found every connection "unresponsive" and terminated it on the first
  // tick. Every interview died at exactly HEARTBEAT_MS, killed by its own
  // liveness check.
  const alive = new WeakSet<WebSocket>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname !== PATH) {
      socket.destroy();
      return;
    }

    const sessionId = url.searchParams.get("sessionId");
    const protocols = (req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((value) => value.trim());
    const bearer = protocols.find((value) =>
      value.startsWith(AUTH_PROTOCOL_PREFIX)
    );

    if (sessionId === null || bearer === undefined) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    void verifier
      .verify(bearer.slice(AUTH_PROTOCOL_PREFIX.length))
      .then((payload) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
          alive.add(ws);
          ws.on("pong", () => alive.add(ws));
          void handleConnection(ws, payload.sub, sessionId);
        });
      })
      .catch(() => {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      });
  });

  // Liveness. A half-open socket — laptop lid closed, network dropped — never
  // fires 'close', so without this the Sonic stream behind it bills until the
  // idle timeout rather than the heartbeat.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate();
        continue;
      }
      alive.delete(ws);
      ws.ping();
    }
  }, SONIC.HEARTBEAT_MS);

  wss.on("close", () => clearInterval(heartbeat));
  return wss;
}
