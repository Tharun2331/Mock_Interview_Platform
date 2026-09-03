/**
 * Nova 2 Sonic protocol spike. Not part of the server — a dev tool for Phase 3.
 *
 * Run:  bun run scripts/sonicSpike.ts
 *
 * Answers the questions the interview loop is built on, before any WebSocket or
 * React exists to obscure them:
 *   1. Does the bidirectional stream open at all with NodeHttp2Handler?
 *   2. Is INTERVIEW_TOOLS shaped the way Sonic expects? (inputSchema.json is a
 *      STRING per the Nova 2 docs, which is what toToolSchema produces.)
 *   3. What does the event sequence actually look like, and how do the
 *      generationStage FINAL/SPECULATIVE markers separate a real transcript
 *      from a preview?
 *   4. Does the interviewer open the conversation the way the prompt intends?
 *
 * It drives the turn with cross-modal TEXT input rather than a recorded WAV.
 * Nova 2 accepts `role: USER, interactive: true` text mid-session, so the whole
 * protocol can be exercised before the AudioWorklet exists.
 *
 * COST: Sonic bills for as long as the stream is open, not per turn. The run is
 * capped by RUN_MS and the closing sequence is in a finally block, so an
 * exception cannot leave the stream open.
 */
import { randomUUID } from "node:crypto";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
  type InvokeModelWithBidirectionalStreamInput,
} from "@aws-sdk/client-bedrock-runtime";
import { NodeHttp2Handler } from "@smithy/node-http-handler";
import { config } from "../lib/config";
import {
  INTERVIEW_TOOLS,
  buildInterviewSystemPrompt,
} from "../agents/mockInterview";
import type { PlanResponse } from "@repo/shared";

const MODEL_ID = "amazon.nova-2-sonic-v1:0";
const RUN_MS = 25_000;
const VOICE_ID = "matthew";

// A stand-in for what the Planner produces, so the spike exercises the real
// system prompt rather than a toy one.
const PLAN: PlanResponse = {
  focusAreas: [
    {
      area: "Event-driven order pipeline design",
      evidence:
        "order-service implements Kafka consumers coordinating order state transitions",
      source: "github",
    },
    {
      area: "Monolith-to-microservices migration",
      evidence: "resume states they led the migration and owned the on-call rotation",
      source: "resume",
    },
  ],
  questionMix: { behavioural: 2, technical: 4, roleSpecific: 1 },
  startingDifficulty: "mid",
  targetMinutes: 25,
  reasoning: "spike fixture",
};

// The SDK wants an AsyncIterable it can pull from for the life of the stream.
// A plain generator will not do: events are produced by the response handler as
// it reacts, so the queue has to stay open and block between pushes.
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

  close(): void {
    this.closed = true;
    // Release anyone blocked, or the stream never terminates and keeps billing.
    for (const waiter of this.waiting) {
      waiter({ value: undefined, done: true });
    }
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

const client = new BedrockRuntimeClient({
  region: config.awsRegion,
  // The default HTTP/1.1 handler cannot hold a duplex stream. This is the whole
  // reason @smithy/node-http-handler is a dependency.
  requestHandler: new NodeHttp2Handler({
    requestTimeout: 300_000,
    sessionTimeout: 300_000,
  }),
});

const promptName = randomUUID();
const queue = new EventQueue();

function send(event: unknown): void {
  queue.push(event);
}

// --- input sequence -------------------------------------------------------

send({
  event: {
    sessionStart: {
      inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
      // New in Nova 2. MEDIUM is the documented default; LOW would suit a
      // candidate thinking through a hard question, which is worth testing
      // against real speech later.
      turnDetectionConfiguration: { endpointingSensitivity: "MEDIUM" },
    },
  },
});

send({
  event: {
    promptStart: {
      promptName,
      textOutputConfiguration: { mediaType: "text/plain" },
      audioOutputConfiguration: {
        mediaType: "audio/lpcm",
        sampleRateHertz: 24000,
        sampleSizeBits: 16,
        channelCount: 1,
        voiceId: VOICE_ID,
        encoding: "base64",
        audioType: "SPEECH",
      },
      toolUseOutputConfiguration: { mediaType: "application/json" },
      // The claim under test: INTERVIEW_TOOLS is passed exactly as the agent
      // module exports it, with no reshaping here.
      toolConfiguration: { tools: INTERVIEW_TOOLS },
    },
  },
});

const systemContentName = randomUUID();
send({
  event: {
    contentStart: {
      promptName,
      contentName: systemContentName,
      type: "TEXT",
      interactive: false,
      role: "SYSTEM",
      textInputConfiguration: { mediaType: "text/plain" },
    },
  },
});
send({
  event: {
    textInput: {
      promptName,
      contentName: systemContentName,
      content: buildInterviewSystemPrompt(PLAN),
    },
  },
});
send({ event: { contentEnd: { promptName, contentName: systemContentName } } });

// An open audio channel, exactly as a browser client would hold one. Sonic is
// speech-to-speech: the first attempt sent only cross-modal text and the model
// consumed it (usageEvents flowed) without ever starting a turn, which is the
// evidence that an AUDIO content block is what actually drives generation.
const audioContentName = randomUUID();
send({
  event: {
    contentStart: {
      promptName,
      contentName: audioContentName,
      type: "AUDIO",
      interactive: true,
      role: "USER",
      audioInputConfiguration: {
        mediaType: "audio/lpcm",
        sampleRateHertz: 16000,
        sampleSizeBits: 16,
        channelCount: 1,
        audioType: "SPEECH",
        encoding: "base64",
      },
    },
  },
});

// 32ms of 16 kHz 16-bit mono silence — 512 samples, 1024 bytes — matching the
// frame size the docs describe and the AudioWorklet will produce.
const SILENT_FRAME = Buffer.alloc(1024).toString("base64");

const pump = setInterval(() => {
  send({
    event: {
      audioInput: {
        promptName,
        contentName: audioContentName,
        content: SILENT_FRAME,
      },
    },
  });
}, 32);

// Sent once the mic is live, the way a candidate saying hello would arrive.
setTimeout(() => {
  const userContentName = randomUUID();
  send({
    event: {
      contentStart: {
        promptName,
        contentName: userContentName,
        type: "TEXT",
        interactive: true,
        role: "USER",
        textInputConfiguration: { mediaType: "text/plain" },
      },
    },
  });
  send({
    event: {
      textInput: {
        promptName,
        contentName: userContentName,
        content: "[The candidate has joined and their microphone is live. Greet them and begin.]",
      },
    },
  });
  send({ event: { contentEnd: { promptName, contentName: userContentName } } });
}, 1000);

// --- run ------------------------------------------------------------------

const seen = new Map<string, number>();
let audioBytes = 0;
const started = Date.now();

function note(kind: string): void {
  seen.set(kind, (seen.get(kind) ?? 0) + 1);
}

const response = await client.send(
  new InvokeModelWithBidirectionalStreamCommand({
    modelId: MODEL_ID,
    body: queue,
  })
);
console.log(`stream open after ${Date.now() - started}ms\n`);

// Graceful close, not a queue.close(). The first run closed the queue directly
// and Sonic rejected the session with "The following prompts were not closed" —
// the closing events were pushed after the queue had already stopped accepting
// them. The documented sequence has to go through the queue while it is open.
function shutdown(): void {
  clearInterval(pump);
  send({ event: { contentEnd: { promptName, contentName: audioContentName } } });
  send({ event: { promptEnd: { promptName } } });
  send({ event: { sessionEnd: {} } });
  // Let the closing events drain before ending the iterator.
  setTimeout(() => queue.close(), 500);
}

const timer = setTimeout(shutdown, RUN_MS);

try {
  for await (const chunk of response.body ?? []) {
    const bytes = chunk.chunk?.bytes;
    if (bytes === undefined) continue;

    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || !("event" in parsed)) {
      continue;
    }

    const event = (parsed as { event: Record<string, unknown> }).event;
    const [kind] = Object.keys(event);
    if (kind === undefined) continue;
    note(kind);

    const at = `${String(Date.now() - started).padStart(6)}ms`;
    const payload = event[kind] as Record<string, unknown>;

    switch (kind) {
      case "contentStart": {
        // This is the field that separates a real transcript from a preview,
        // and USER (what the candidate said) from ASSISTANT (what we say).
        console.log(
          `${at}  contentStart  role=${String(payload.role)} type=${String(
            payload.type
          )} stage=${String(payload.additionalModelFields ?? "-")}`
        );
        break;
      }
      case "textOutput":
        console.log(`${at}  textOutput    ${JSON.stringify(payload.content)}`);
        break;
      case "audioOutput":
        audioBytes += String(payload.content ?? "").length;
        break;
      case "toolUse":
        console.log(
          `${at}  TOOL USE      ${String(payload.toolName)} ${JSON.stringify(
            payload.content
          )}`
        );
        break;
      case "contentEnd":
        console.log(
          `${at}  contentEnd    type=${String(payload.type)} stop=${String(
            payload.stopReason
          )}`
        );
        break;
      case "completionEnd":
        console.log(`${at}  completionEnd stop=${String(payload.stopReason)}`);
        break;
      case "usageEvent":
        break;
      default:
        console.log(`${at}  ${kind}`);
    }
  }
} catch (error) {
  // Bedrock's modelled stream exceptions are not Error instances, so String()
  // yields "[object Object]" and hides the only useful information.
  console.error("\nSTREAM ERROR:");
  console.error(
    JSON.stringify(
      error,
      (_key, value: unknown) =>
        value instanceof Uint8Array ? new TextDecoder().decode(value) : value,
      2
    )
  );
  if (error instanceof Error) console.error(`${error.name}: ${error.message}`);
} finally {
  clearTimeout(timer);
  clearInterval(pump);
  // Belt and braces: shutdown() has usually run already via the timer, but an
  // exception mid-stream must not leave the queue open. Sonic bills by open
  // duration, so this belongs in `finally`, not the happy path.
  queue.close();
  client.destroy();
}

console.log(`\n--- event counts ---`);
for (const [kind, count] of [...seen].sort()) console.log(`  ${kind}: ${count}`);
console.log(`  audioOutput base64 chars: ${audioBytes}`);
console.log(`\nstream open for ${((Date.now() - started) / 1000).toFixed(1)}s`);
