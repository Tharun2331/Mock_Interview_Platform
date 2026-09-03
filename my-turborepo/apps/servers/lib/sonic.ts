import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { config } from "./config";
import { SONIC } from "./constants";
import type { CompletedExchange } from "./exchangeBuffer";

// One Nova 2 Sonic bidirectional stream, owned by one caller for its lifetime.
//
// Ported from the AWS websocket-nodejs sample with three deliberate changes:
//
//   - No `activeSessions` map. The sample keys sessions by socket.id because
//     socket.io needs lookup by id; holding the session in the WebSocket
//     handler's closure instead removes the shared mutable map and the leak
//     path that comes with it.
//   - No rxjs. The sample uses two `Subject`s purely as queue signals, which
//     plain promises do without the dependency.
//   - Typed events instead of `any`.
//
// Every exit path must reach close(). Sonic bills for as long as the stream is
// open, not per turn, so a leaked stream is a meter left running.

export type SonicEvent =
  | { kind: "contentStart"; role: string; type: string; generationStage: string | null }
  | { kind: "textOutput"; content: string }
  | { kind: "audioOutput"; base64: string }
  | { kind: "toolUse"; toolName: string; toolUseId: string; content: string }
  | { kind: "contentEnd"; type: string; stopReason: string | null }
  | { kind: "completionEnd"; stopReason: string | null }
  | { kind: "error"; message: string };

export type SonicToolSpec = {
  readonly toolSpec: {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: { readonly json: string };
  };
};

type SonicSessionArgs = {
  systemPrompt: string;
  tools: readonly SonicToolSpec[];
  // Past exchanges to restore. Empty for a first stream; populated when this
  // session is replacing one that hit Bedrock's 8-minute ceiling.
  history?: readonly CompletedExchange[];
  // The USER turn that opened the original stream, replayed first so the
  // restored history does not begin with the assistant — which Sonic rejects.
  historyPreamble?: string;
  onEvent: (event: SonicEvent) => void;
  // Fired when the stream ends for any reason, including idle timeout. The
  // caller uses it to close the WebSocket — the two lifetimes are joined.
  onClose: (reason: string) => void;
};

// The SDK pulls from this for the life of the stream, so it cannot be a plain
// generator: events are produced asynchronously as audio arrives and as the
// model asks for tool results, so the iterator has to block between pushes.
class EventQueue {
  private readonly pending: InvokeModelWithBidirectionalStreamInput[] = [];
  private readonly waiting: ((
    value: IteratorResult<InvokeModelWithBidirectionalStreamInput>
  ) => void)[] = [];
  private closed = false;

  push(event: unknown): void {
    if (this.closed) return;
    const chunk: InvokeModelWithBidirectionalStreamInput = {
      chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) },
    };
    const waiter = this.waiting.shift();
    if (waiter !== undefined) waiter({ value: chunk, done: false });
    else this.pending.push(chunk);
  }

  // How many events are waiting because the stream has not pulled them yet.
  // This is the real backpressure signal: the SDK drains `pending` at whatever
  // rate the HTTP/2 stream allows, so a growing depth means the client is
  // producing audio faster than Bedrock is accepting it.
  get depth(): number {
    return this.pending.length;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    // Release anyone blocked on next(), or the iterator never terminates and
    // the stream keeps billing.
    for (const waiter of this.waiting) waiter({ value: undefined, done: true });
    this.waiting.length = 0;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      const queued = this.pending.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.closed) return;
      const next = await new Promise<
        IteratorResult<InvokeModelWithBidirectionalStreamInput>
      >((resolve) => this.waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

// Shared across sessions. HTTP/2 multiplexes concurrent streams over one
// connection, so this is a connection pool rather than a per-interview cost.
// The default HTTP/1.1 handler cannot hold a duplex stream at all.
const sonicClient = new BedrockRuntimeClient({
  region: config.awsRegion,
  requestHandler: new NodeHttp2Handler({
    requestTimeout: SONIC.REQUEST_TIMEOUT_MS,
    sessionTimeout: SONIC.SESSION_TIMEOUT_MS,
    disableConcurrentStreams: false,
    maxConcurrentStreams: 20,
  }),
});

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export class SonicSession {
  private readonly queue = new EventQueue();
  private readonly promptName = randomUUID();
  private readonly audioContentName = randomUUID();
  private readonly args: SonicSessionArgs;

  private active = true;
  private audioOpen = false;
  private dropped = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(args: SonicSessionArgs) {
    this.args = args;
  }

  get isActive(): boolean {
    return this.active;
  }

  // Opens the stream and starts consuming responses. Resolves once the stream
  // is established; response processing continues in the background until the
  // model or close() ends it.
  async start(): Promise<void> {
    this.send({
      event: {
        sessionStart: {
          inferenceConfiguration: {
            maxTokens: SONIC.MAX_TOKENS,
            topP: SONIC.TOP_P,
            temperature: SONIC.TEMPERATURE,
          },
          turnDetectionConfiguration: {
            endpointingSensitivity: SONIC.ENDPOINTING_SENSITIVITY,
          },
        },
      },
    });

    this.send({
      event: {
        promptStart: {
          promptName: this.promptName,
          textOutputConfiguration: { mediaType: "text/plain" },
          audioOutputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: SONIC.OUTPUT_SAMPLE_RATE,
            sampleSizeBits: SONIC.SAMPLE_SIZE_BITS,
            channelCount: SONIC.CHANNEL_COUNT,
            voiceId: SONIC.VOICE_ID,
            encoding: "base64",
            audioType: "SPEECH",
          },
          toolUseOutputConfiguration: { mediaType: "application/json" },
          toolConfiguration: { tools: this.args.tools },
        },
      },
    });

    const systemContentName = randomUUID();
    this.send({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: systemContentName,
          type: "TEXT",
          interactive: false,
          role: "SYSTEM",
          textInputConfiguration: { mediaType: "text/plain" },
        },
      },
    });
    this.send({
      event: {
        textInput: {
          promptName: this.promptName,
          contentName: systemContentName,
          content: this.args.systemPrompt,
        },
      },
    });
    this.send({
      event: {
        contentEnd: {
          promptName: this.promptName,
          contentName: systemContentName,
        },
      },
    });

    // Conversation history, replayed so a renewed stream continues the
    // interview rather than starting a new one. The docs allow this exactly
    // once, after the system prompt and before audio begins — which is why it
    // sits here and not anywhere else.
    const history = this.args.history ?? [];
    const turns: { role: "USER" | "ASSISTANT"; content: string }[] = [];

    if (history.length > 0) {
      // Sonic rejects a history whose first message is from the assistant:
      // "First message in chat history should not be Assistant." An interview
      // inherently opens with the interviewer asking, so replaying exchanges
      // directly fails every time — which is exactly how this was found.
      //
      // The kickoff is the honest fix rather than a workaround: the original
      // stream really did begin with this USER turn, so replaying it restores
      // the true order instead of inventing one.
      const preamble = this.args.historyPreamble;
      if (preamble !== undefined) {
        turns.push({ role: "USER", content: preamble });
      }
    }

    for (const turn of history) {
      turns.push({ role: "ASSISTANT", content: turn.questionText });
      turns.push({ role: "USER", content: turn.transcript });
    }

    for (const { role, content } of turns) {
      if (content.trim().length === 0) continue;

      const contentName = randomUUID();
      this.send({
        event: {
          contentStart: {
            promptName: this.promptName,
            contentName,
            type: "TEXT",
            // False: this is history being restored, not someone speaking.
            interactive: false,
            role,
            textInputConfiguration: { mediaType: "text/plain" },
          },
        },
      });
      this.send({
        event: {
          textInput: { promptName: this.promptName, contentName, content },
        },
      });
      this.send({
        event: { contentEnd: { promptName: this.promptName, contentName } },
      });
    }

    // The audio channel opens immediately and stays open for the whole
    // interview. Verified in scripts/sonicSpike.ts: with no AUDIO content
    // block the model consumes input and never generates a turn — Sonic is
    // genuinely speech-to-speech, and text input is an adjunct to a live mic
    // rather than a substitute for one.
    this.send({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          type: "AUDIO",
          interactive: true,
          role: "USER",
          audioInputConfiguration: {
            mediaType: "audio/lpcm",
            sampleRateHertz: SONIC.INPUT_SAMPLE_RATE,
            sampleSizeBits: SONIC.SAMPLE_SIZE_BITS,
            channelCount: SONIC.CHANNEL_COUNT,
            audioType: "SPEECH",
            encoding: "base64",
          },
        },
      },
    });
    this.audioOpen = true;

    const response = await sonicClient.send(
      new InvokeModelWithBidirectionalStreamCommand({
        modelId: SONIC.MODEL_ID,
        body: this.queue,
      })
    );

    this.resetIdleTimer();
    this.maxTimer = setTimeout(
      () => void this.close("max session duration reached"),
      SONIC.MAX_SESSION_MS
    );

    // Deliberately not awaited. The caller needs start() to resolve so it can
    // begin forwarding audio; responses arrive for the rest of the session.
    void this.consume(response.body);
  }

  private send(event: unknown): void {
    if (!this.active) return;
    this.queue.push(event);
  }

  // Makes the interviewer speak first.
  //
  // Sonic generates in response to input; with nothing but silence on the mic
  // it waits indefinitely, so the candidate ends up having to say hello to a
  // silent interviewer — which reads as a broken connection. A cross-modal
  // text turn triggers generation without any audio, which the spike confirmed.
  //
  // Sent as `role: USER` because that is what starts a turn. It is not echoed
  // back as a transcript: those come from ASR on real audio, so this never
  // appears as something the candidate said.
  kickoff(note: string): void {
    if (!this.active) return;

    const contentName = randomUUID();
    this.send({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName,
          type: "TEXT",
          interactive: true,
          role: "USER",
          textInputConfiguration: { mediaType: "text/plain" },
        },
      },
    });
    this.send({
      event: {
        textInput: { promptName: this.promptName, contentName, content: note },
      },
    });
    this.send({
      event: { contentEnd: { promptName: this.promptName, contentName } },
    });
  }

  // 16 kHz 16-bit mono PCM, exactly as the AudioWorklet produced it.
  sendAudio(frame: Buffer): void {
    if (!this.active || !this.audioOpen) return;

    // Backpressure, measured against what the stream has actually not yet
    // pulled. Dropping the newest frame is deliberate: the alternative is an
    // unbounded queue that grows until the task dies, and a few dropped frames
    // degrade one turn rather than the whole service.
    //
    // The idle timer is reset regardless — the candidate is plainly still
    // there, so a dropped frame must not look like an abandoned session.
    this.resetIdleTimer();
    if (this.queue.depth >= SONIC.MAX_QUEUED_AUDIO_FRAMES) {
      this.dropped += 1;
      return;
    }

    this.send({
      event: {
        audioInput: {
          promptName: this.promptName,
          contentName: this.audioContentName,
          content: frame.toString("base64"),
        },
      },
    });
  }

  // Surfaced so a caller can log it at close. Silent frame loss would otherwise
  // present as the model mishearing the candidate.
  get droppedFrames(): number {
    return this.dropped;
  }

  // Answers a toolUse the model raised. Content must be a JSON string, not an
  // object — the model reads it as text.
  sendToolResult(toolUseId: string, result: unknown): void {
    if (!this.active) return;

    const contentName = randomUUID();
    this.send({
      event: {
        contentStart: {
          promptName: this.promptName,
          contentName,
          interactive: false,
          type: "TOOL",
          role: "TOOL",
          toolResultInputConfiguration: {
            toolUseId,
            type: "TEXT",
            textInputConfiguration: { mediaType: "text/plain" },
          },
        },
      },
    });
    this.send({
      event: {
        toolResult: {
          promptName: this.promptName,
          contentName,
          content: JSON.stringify(result),
        },
      },
    });
    this.send({
      event: { contentEnd: { promptName: this.promptName, contentName } },
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => void this.close("idle timeout"),
      SONIC.IDLE_TIMEOUT_MS
    );
  }

  private async consume(
    body: AsyncIterable<{ chunk?: { bytes?: Uint8Array } }> | undefined
  ): Promise<void> {
    try {
      for await (const chunk of body ?? []) {
        if (!this.active) break;
        const bytes = chunk.chunk?.bytes;
        if (bytes === undefined) continue;

        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          // A malformed frame is not worth ending an interview over.
          continue;
        }
        this.dispatch(parsed);
      }
    } catch (error) {
      this.args.onEvent({
        kind: "error",
        message: describeStreamError(error),
      });
    } finally {
      await this.close("stream ended");
    }
  }

  private dispatch(parsed: unknown): void {
    if (typeof parsed !== "object" || parsed === null || !("event" in parsed)) {
      return;
    }
    const envelope = (parsed as { event: unknown }).event;
    if (typeof envelope !== "object" || envelope === null) return;

    const event = envelope as Record<string, unknown>;
    const emit = this.args.onEvent;

    const contentStart = event.contentStart;
    if (typeof contentStart === "object" && contentStart !== null) {
      const payload = contentStart as Record<string, unknown>;
      emit({
        kind: "contentStart",
        role: readString(payload.role) ?? "",
        type: readString(payload.type) ?? "",
        // Carries {"generationStage":"FINAL"|"SPECULATIVE"} as a JSON string.
        // This is the only signal separating a real transcript from a preview,
        // so it is passed through rather than interpreted here.
        generationStage: readString(payload.additionalModelFields),
      });
      return;
    }

    const textOutput = event.textOutput;
    if (typeof textOutput === "object" && textOutput !== null) {
      const content = readString((textOutput as Record<string, unknown>).content);
      if (content !== null) emit({ kind: "textOutput", content });
      return;
    }

    const audioOutput = event.audioOutput;
    if (typeof audioOutput === "object" && audioOutput !== null) {
      const base64 = readString((audioOutput as Record<string, unknown>).content);
      if (base64 !== null) emit({ kind: "audioOutput", base64 });
      return;
    }

    const toolUse = event.toolUse;
    if (typeof toolUse === "object" && toolUse !== null) {
      const payload = toolUse as Record<string, unknown>;
      emit({
        kind: "toolUse",
        toolName: readString(payload.toolName) ?? "",
        toolUseId: readString(payload.toolUseId) ?? "",
        content: readString(payload.content) ?? "{}",
      });
      return;
    }

    const contentEnd = event.contentEnd;
    if (typeof contentEnd === "object" && contentEnd !== null) {
      const payload = contentEnd as Record<string, unknown>;
      emit({
        kind: "contentEnd",
        type: readString(payload.type) ?? "",
        // "INTERRUPTED" here is barge-in: the candidate talked over the
        // interviewer. The client must drop queued audio when it sees this.
        stopReason: readString(payload.stopReason),
      });
      return;
    }

    const completionEnd = event.completionEnd;
    if (typeof completionEnd === "object" && completionEnd !== null) {
      emit({
        kind: "completionEnd",
        stopReason: readString(
          (completionEnd as Record<string, unknown>).stopReason
        ),
      });
    }
    // usageEvent and completionStart are intentionally dropped — nothing
    // downstream reads them yet, and forwarding them would be noise.
  }

  // Idempotent, and safe to call from any exit path. The documented closing
  // sequence has to travel through the queue while it is still open: closing
  // the queue first makes Sonic reject the session with "The following prompts
  // were not closed", which is how the spike first failed.
  async close(reason: string): Promise<void> {
    if (!this.active) return;
    this.active = false;

    if (this.idleTimer !== null) clearTimeout(this.idleTimer);
    if (this.maxTimer !== null) clearTimeout(this.maxTimer);

    if (this.audioOpen) {
      this.queue.push({
        event: {
          contentEnd: {
            promptName: this.promptName,
            contentName: this.audioContentName,
          },
        },
      });
      this.audioOpen = false;
    }
    this.queue.push({ event: { promptEnd: { promptName: this.promptName } } });
    this.queue.push({ event: { sessionEnd: {} } });

    // Let the closing events drain before ending the iterator.
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.queue.close();

    this.args.onClose(reason);
  }
}

// One interview, across however many Sonic streams it takes.
//
// Bedrock closes a bidirectional stream after roughly 8 minutes — measured at
// 7m19s of real conversation — and that is not configurable. A 40-minute plan
// therefore cannot run on one stream, so this opens a replacement shortly
// before the ceiling, replays the conversation so far as history, and swaps.
//
// The swap is deliberately ordered: the new stream is fully open before the old
// one is closed, so audio always has somewhere to go. The candidate hears
// nothing, because their microphone and WebSocket never move.
export class SonicConversation {
  private current: SonicSession | null = null;
  private renewing = false;
  private closed = false;
  private renewTimer: ReturnType<typeof setTimeout> | null = null;
  private renewals = 0;
  private kickoffNote: string | undefined;

  constructor(
    private readonly args: Omit<SonicSessionArgs, "history" | "onClose"> & {
      // Supplies the history to replay at renewal time. A callback rather than
      // an array because the exchanges accumulate after this is constructed.
      getHistory: () => readonly CompletedExchange[];
      onClose: (reason: string) => void;
      // Fired around a renewal so the caller can log or surface it.
      onRenew?: (renewals: number) => void;
      // How long to run a stream before replacing it. Defaults to Bedrock's
      // ceiling minus the head start. Overridable so renewal can be exercised
      // in seconds rather than only after six and a half minutes — a handover
      // that cannot be tested is a handover nobody has seen work.
      renewAfterMs?: number;
    }
  ) {}

  get renewalCount(): number {
    return this.renewals;
  }

  async start(): Promise<void> {
    this.current = await this.open([]);
    this.scheduleRenewal();
  }

  private async open(
    history: readonly CompletedExchange[]
  ): Promise<SonicSession> {
    const session = new SonicSession({
      systemPrompt: this.args.systemPrompt,
      tools: this.args.tools,
      history,
      // Remembered from the first kickoff so every replacement stream can
      // replay it as the opening USER turn.
      historyPreamble: this.kickoffNote,
      onEvent: this.args.onEvent,
      onClose: (reason) => {
        // A stream ending mid-renewal is the expected handover, not the end of
        // the interview. Only an unexpected close ends the conversation.
        if (this.renewing || this.closed) return;
        this.args.onClose(reason);
      },
    });
    await session.start();
    return session;
  }

  private scheduleRenewal(): void {
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    this.renewTimer = setTimeout(
      () => void this.renew(),
      this.args.renewAfterMs ??
        SONIC.STREAM_LIFETIME_MS - SONIC.RENEW_BEFORE_MS
    );
  }

  private async renew(): Promise<void> {
    if (this.closed || this.renewing) return;
    this.renewing = true;

    const previous = this.current;
    try {
      // Only the most recent exchanges. Replaying everything would grow the
      // prompt without bound across a long interview, and the session brief in
      // the system prompt already carries the candidate's background.
      const history = this.args
        .getHistory()
        .slice(-SONIC.MAX_REPLAYED_EXCHANGES);

      // Opened before the old one closes, so a frame arriving mid-swap still
      // has a live stream to land on.
      const next = await this.open(history);
      this.current = next;
      this.renewals += 1;
      this.args.onRenew?.(this.renewals);
      this.scheduleRenewal();
    } catch (error) {
      // The replacement failed. The old stream is still open and still works
      // until Bedrock closes it, so the interview continues on borrowed time
      // rather than ending here.
      this.args.onEvent({
        kind: "error",
        message: `renewal failed: ${describeStreamError(error)}`,
      });
    } finally {
      // The old stream is closed BEFORE the flag drops. Reversed, its onClose
      // fires while `renewing` is already false, the guard in open() lets it
      // through, and the route treats a routine handover as the interview
      // ending — killing the session at the first renewal. The test caught this
      // as a stray "closed: renewed" that would have been fatal in the route.
      if (previous !== null && previous !== this.current) {
        await previous.close("renewed");
      }
      this.renewing = false;
    }
  }

  sendAudio(frame: Buffer): void {
    this.current?.sendAudio(frame);
  }

  sendToolResult(toolUseId: string, result: unknown): void {
    this.current?.sendToolResult(toolUseId, result);
  }

  kickoff(note: string): void {
    // Kept so renewals can replay it as the opening USER turn.
    this.kickoffNote = note;
    this.current?.kickoff(note);
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.renewTimer !== null) clearTimeout(this.renewTimer);
    await this.current?.close(reason);
    this.args.onClose(reason);
  }
}

// Bedrock's modelled stream exceptions are not Error instances, so String()
// yields "[object Object]" and hides the only useful information.
function describeStreamError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return JSON.stringify(error);
}
