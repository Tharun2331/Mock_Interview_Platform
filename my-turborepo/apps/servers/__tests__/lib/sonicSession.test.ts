import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { SONIC } from "../../lib/constants";
import type { CompletedExchange } from "../../lib/exchangeBuffer";
import {
  FakeSonicStream,
  inbound,
  settle,
  tapOutbound,
  type OutboundTap,
} from "../helpers/sonicStream";

// One Sonic stream, both directions.
//
// Mocked at `BedrockRuntimeClient` rather than by replacing lib/sonic, so the
// real session speaks the real protocol into a fake transport. That is the
// whole point: this file exists to pin the EVENT SEQUENCE Sonic requires, and
// a stubbed module would assert nothing about it.
//
// Three failures documented in sonic.ts are reproduced here as tests rather
// than trusted as comments — the history-must-not-start-with-assistant
// rejection, the prompts-were-not-closed rejection, and silent frame loss
// under backpressure.

const bedrock = mockClient(BedrockRuntimeClient);
const { SonicSession } = await import("../../lib/sonic");
type SonicEvent = Parameters<
  NonNullable<ConstructorParameters<typeof SonicSession>[0]["onEvent"]>
>[0];

afterAll(() => bedrock.restore());

beforeEach(() => bedrock.reset());

type Opened = {
  session: InstanceType<typeof SonicSession>;
  stream: FakeSonicStream;
  tap: OutboundTap;
  events: SonicEvent[];
  closes: string[];
  shutdown: () => Promise<void>;
};

async function open(
  args: {
    systemPrompt?: string;
    history?: readonly CompletedExchange[];
    historyPreamble?: string;
    // Backpressure is measured on events NOBODY has pulled, so the one test
    // that asserts it must leave the queue untapped.
    tap?: boolean;
  } = {},
): Promise<Opened> {
  const stream = new FakeSonicStream();
  bedrock
    .on(InvokeModelWithBidirectionalStreamCommand)
    .resolves({ body: stream as never });

  const events: SonicEvent[] = [];
  const closes: string[] = [];

  const session = new SonicSession({
    systemPrompt: args.systemPrompt ?? "SYSTEM PROMPT",
    tools: [
      {
        toolSpec: {
          name: "logExchange",
          description: "log it",
          inputSchema: { json: "{}" },
        },
      },
    ],
    history: args.history,
    historyPreamble: args.historyPreamble,
    onEvent: (event) => events.push(event),
    onClose: (reason) => closes.push(reason),
  });

  await session.start();

  const body = bedrock.commandCalls(
    InvokeModelWithBidirectionalStreamCommand,
  )[0]?.args[0].input.body;

  const tap: OutboundTap =
    args.tap === false
      ? {
          events: [],
          names: () => [],
          ofName: () => [],
          done: Promise.resolve(),
        }
      : tapOutbound(body);

  await settle();

  return {
    session,
    stream,
    tap,
    events,
    closes,
    shutdown: async () => {
      await session.close("test over");
      stream.end();
      await tap.done;
    },
  };
}

function exchange(question: string, answer: string): CompletedExchange {
  return {
    questionId: "01J000000000000000000000",
    questionText: question,
    transcript: answer,
    askedAt: "2026-09-16T10:00:00.000Z",
    durationMs: 1000,
    interrupted: false,
  };
}

describe("opening a stream", () => {
  it("sends the documented handshake in order", async () => {
    const open_ = await open();

    // sessionStart before promptStart before the system block before audio.
    // Sonic rejects anything else, and the order is not recoverable from the
    // response — the stream simply fails.
    expect(open_.tap.names().slice(0, 6)).toEqual([
      "sessionStart",
      "promptStart",
      "contentStart",
      "textInput",
      "contentEnd",
      "contentStart",
    ]);

    await open_.shutdown();
  });

  it("carries the tool configuration on promptStart", async () => {
    const open_ = await open();

    const promptStart = open_.tap.ofName("promptStart")[0];
    const toolConfig = promptStart?.toolConfiguration as {
      tools: { toolSpec: { name: string } }[];
    };
    expect(toolConfig.tools[0]?.toolSpec.name).toBe("logExchange");

    await open_.shutdown();
  });

  it("sends the system prompt it was given", async () => {
    const open_ = await open({ systemPrompt: "YOU ARE AN INTERVIEWER" });

    expect(open_.tap.ofName("textInput")[0]?.content).toBe(
      "YOU ARE AN INTERVIEWER",
    );

    await open_.shutdown();
  });

  // The audio block opens immediately and stays open. Verified in the spike:
  // with no AUDIO content block the model consumes input and never generates a
  // turn, because Sonic is genuinely speech-to-speech.
  it("opens an interactive audio channel at the input sample rate", async () => {
    const open_ = await open();

    const audioStart = open_.tap
      .ofName("contentStart")
      .find((payload) => payload.type === "AUDIO");

    expect(audioStart?.interactive).toBe(true);
    expect(audioStart?.role).toBe("USER");
    expect(
      (audioStart?.audioInputConfiguration as { sampleRateHertz: number })
        .sampleRateHertz,
    ).toBe(SONIC.INPUT_SAMPLE_RATE);

    await open_.shutdown();
  });

  it("uses one promptName for every block in the stream", async () => {
    const open_ = await open();

    const names = new Set(
      open_.tap.events
        .map((event) => event.payload.promptName)
        .filter((value): value is string => typeof value === "string"),
    );
    expect(names.size).toBe(1);

    await open_.shutdown();
  });

  it("sends no history blocks when there is none", async () => {
    const open_ = await open();

    // System block only: one textInput, and the content blocks are the system
    // pair plus audio.
    expect(open_.tap.ofName("textInput")).toHaveLength(1);

    await open_.shutdown();
  });
});

// The failure that makes renewal work at all. Sonic rejects a replayed history
// whose first message is from the assistant — "First message in chat history
// should not be Assistant" — and an interview inherently opens with the
// interviewer asking. Every renewal failed until the kickoff was replayed first.
describe("replaying history into a renewed stream", () => {
  it("replays the kickoff as the opening USER turn", async () => {
    const open_ = await open({
      history: [exchange("Tell me about Kafka.", "I used it at work.")],
      historyPreamble: "[The candidate has joined.]",
    });

    const roles = open_.tap
      .ofName("contentStart")
      .filter((payload) => payload.type === "TEXT" && payload.role !== "SYSTEM")
      .map((payload) => payload.role);

    expect(roles[0]).toBe("USER");

    await open_.shutdown();
  });

  it("replays each exchange as assistant-then-user", async () => {
    const open_ = await open({
      history: [
        exchange("First question?", "First answer."),
        exchange("Second question?", "Second answer."),
      ],
      historyPreamble: "[kickoff]",
    });

    const contents = open_.tap.ofName("textInput").map((p) => p.content);

    expect(contents).toEqual([
      "SYSTEM PROMPT",
      "[kickoff]",
      "First question?",
      "First answer.",
      "Second question?",
      "Second answer.",
    ]);

    await open_.shutdown();
  });

  // Restored history is not someone speaking. Marked non-interactive so Sonic
  // does not treat the replay as a live turn and answer it.
  it("marks replayed turns as non-interactive", async () => {
    const open_ = await open({
      history: [exchange("Q?", "A.")],
      historyPreamble: "[kickoff]",
    });

    const replayed = open_.tap
      .ofName("contentStart")
      .filter(
        (payload) => payload.type === "TEXT" && payload.role !== "SYSTEM",
      );

    expect(replayed.every((payload) => payload.interactive === false)).toBe(
      true,
    );

    await open_.shutdown();
  });

  // An exchange whose transcript never arrived would otherwise replay as an
  // empty USER turn, which Sonic rejects as an empty content block.
  it("skips a turn whose content is blank", async () => {
    const open_ = await open({
      history: [exchange("A question nobody answered.", "   ")],
      historyPreamble: "[kickoff]",
    });

    const contents = open_.tap.ofName("textInput").map((p) => p.content);

    expect(contents).toContain("A question nobody answered.");
    expect(contents).not.toContain("   ");

    await open_.shutdown();
  });
});

describe("kickoff", () => {
  // Sonic generates in response to input. With nothing but silence on the mic
  // it waits indefinitely, so the candidate ends up greeting a silent
  // interviewer — which reads as a broken connection.
  it("sends an interactive USER text turn", async () => {
    const open_ = await open();
    const before = open_.tap.events.length;

    open_.session.kickoff("[begin]");
    await settle();

    const sent = open_.tap.events.slice(before);
    expect(sent.map((event) => event.name)).toEqual([
      "contentStart",
      "textInput",
      "contentEnd",
    ]);
    expect(sent[0]?.payload.role).toBe("USER");
    expect(sent[0]?.payload.interactive).toBe(true);
    expect(sent[1]?.payload.content).toBe("[begin]");

    await open_.shutdown();
  });

  it("is a no-op once the session is closed", async () => {
    const open_ = await open();
    await open_.session.close("done");

    const before = open_.tap.events.length;
    open_.session.kickoff("[too late]");
    await settle();

    expect(open_.tap.events.length).toBe(before);

    open_.stream.end();
    await open_.tap.done;
  });
});

describe("audio in", () => {
  it("sends a frame as base64 audioInput", async () => {
    const open_ = await open();

    open_.session.sendAudio(Buffer.from([1, 2, 3, 4]));
    await settle();

    const audioInput = open_.tap.ofName("audioInput")[0];
    expect(audioInput?.content).toBe(
      Buffer.from([1, 2, 3, 4]).toString("base64"),
    );

    await open_.shutdown();
  });

  // Dropping the NEWEST frame is deliberate: the alternative is an unbounded
  // queue that grows until the task dies. A few dropped frames degrade one turn
  // rather than the whole service.
  it("drops frames once the queue is deeper than the cap", async () => {
    const open_ = await open({ tap: false });

    const frame = Buffer.from([0, 0, 0, 0]);
    for (let i = 0; i < SONIC.MAX_QUEUED_AUDIO_FRAMES + 50; i += 1) {
      open_.session.sendAudio(frame);
    }

    expect(open_.session.droppedFrames).toBeGreaterThan(0);

    await open_.session.close("done");
    open_.stream.end();
  });

  // Silent frame loss would present as the model mishearing the candidate, so
  // the count is surfaced for the caller to log at close.
  it("reports zero dropped frames on a healthy stream", async () => {
    const open_ = await open();

    open_.session.sendAudio(Buffer.from([1]));
    await settle();

    expect(open_.session.droppedFrames).toBe(0);

    await open_.shutdown();
  });

  it("is a no-op once the session is closed", async () => {
    const open_ = await open();
    await open_.session.close("done");

    const before = open_.tap.events.length;
    open_.session.sendAudio(Buffer.from([9]));
    await settle();

    expect(open_.tap.events.length).toBe(before);

    open_.stream.end();
    await open_.tap.done;
  });
});

describe("answering a tool call", () => {
  it("sends the result as a JSON string, not an object", async () => {
    const open_ = await open();

    open_.session.sendToolResult("tool-1", { ok: true, exchangesLogged: 3 });
    await settle();

    const toolResult = open_.tap.ofName("toolResult")[0];
    // A string the model reads as text. Sent as an object it is silently
    // ignored, and the interviewer waits for a result that never lands.
    expect(typeof toolResult?.content).toBe("string");
    expect(JSON.parse(String(toolResult?.content))).toEqual({
      ok: true,
      exchangesLogged: 3,
    });

    await open_.shutdown();
  });

  it("names the toolUseId it is answering", async () => {
    const open_ = await open();

    open_.session.sendToolResult("tool-abc", { ok: true });
    await settle();

    const start = open_.tap
      .ofName("contentStart")
      .find((payload) => payload.type === "TOOL");
    const toolConfig = start?.toolResultInputConfiguration as {
      toolUseId: string;
    };

    expect(toolConfig.toolUseId).toBe("tool-abc");

    await open_.shutdown();
  });
});

// Sonic rejects a session with "The following prompts were not closed" if the
// queue ends before the closing sequence travels through it. That is how the
// spike first failed, and the ordering is the fix.
describe("closing", () => {
  it("sends contentEnd, promptEnd and sessionEnd before ending the queue", async () => {
    const open_ = await open();

    await open_.session.close("finished");
    open_.stream.end();
    await open_.tap.done;

    expect(open_.tap.names().slice(-3)).toEqual([
      "contentEnd",
      "promptEnd",
      "sessionEnd",
    ]);
  });

  it("reports the reason to the caller", async () => {
    const open_ = await open();

    await open_.session.close("idle timeout");

    expect(open_.closes).toEqual(["idle timeout"]);

    open_.stream.end();
    await open_.tap.done;
  });

  // Every exit path calls close(), and several can fire at once — the model
  // ending, the socket dropping, a timer. A second close must not send a second
  // sessionEnd or fire onClose twice.
  it("is idempotent", async () => {
    const open_ = await open();

    await open_.session.close("first");
    await open_.session.close("second");

    expect(open_.closes).toEqual(["first"]);
    expect(open_.tap.ofName("sessionEnd")).toHaveLength(1);

    open_.stream.end();
    await open_.tap.done;
  });

  it("reports itself inactive afterwards", async () => {
    const open_ = await open();

    expect(open_.session.isActive).toBe(true);
    await open_.session.close("done");
    expect(open_.session.isActive).toBe(false);

    open_.stream.end();
    await open_.tap.done;
  });
});

describe("events coming back", () => {
  it("passes the generation stage through rather than interpreting it", async () => {
    const open_ = await open();

    open_.stream.push(
      inbound.contentStart({
        role: "USER",
        type: "TEXT",
        generationStage: "FINAL",
      }),
    );
    await settle();

    const event = open_.events.find((e) => e.kind === "contentStart");
    expect(event).toMatchObject({ role: "USER", type: "TEXT" });
    // The only signal separating a real transcript from a preview, so it is
    // forwarded verbatim for the route to read.
    expect(
      String((event as { generationStage: string }).generationStage),
    ).toContain("FINAL");

    await open_.shutdown();
  });

  it("emits transcript text", async () => {
    const open_ = await open();

    open_.stream.push(inbound.textOutput("Tell me about Kafka."));
    await settle();

    expect(open_.events).toContainEqual({
      kind: "textOutput",
      content: "Tell me about Kafka.",
    });

    await open_.shutdown();
  });

  it("emits audio as base64 for the caller to decode", async () => {
    const open_ = await open();

    open_.stream.push(inbound.audioOutput("AQID"));
    await settle();

    expect(open_.events).toContainEqual({
      kind: "audioOutput",
      base64: "AQID",
    });

    await open_.shutdown();
  });

  it("emits a tool call with its id and raw input", async () => {
    const open_ = await open();

    open_.stream.push(
      inbound.toolUse({
        toolName: "logExchange",
        toolUseId: "t-1",
        content: '{"exchangeType":"followup"}',
      }),
    );
    await settle();

    expect(open_.events).toContainEqual({
      kind: "toolUse",
      toolName: "logExchange",
      toolUseId: "t-1",
      content: '{"exchangeType":"followup"}',
    });

    await open_.shutdown();
  });

  // INTERRUPTED here is barge-in. The client must drop queued playback when it
  // sees this, so the stop reason has to survive the hop.
  it("carries the stop reason on contentEnd", async () => {
    const open_ = await open();

    open_.stream.push(
      inbound.contentEnd({ type: "AUDIO", stopReason: "INTERRUPTED" }),
    );
    await settle();

    expect(open_.events).toContainEqual({
      kind: "contentEnd",
      type: "AUDIO",
      stopReason: "INTERRUPTED",
    });

    await open_.shutdown();
  });

  it("emits completionEnd", async () => {
    const open_ = await open();

    open_.stream.push(inbound.completionEnd("END_TURN"));
    await settle();

    expect(open_.events).toContainEqual({
      kind: "completionEnd",
      stopReason: "END_TURN",
    });

    await open_.shutdown();
  });

  // Nothing downstream reads usage or completionStart, and forwarding them
  // would be noise on a channel the route switches on.
  it("drops events nothing downstream reads", async () => {
    const open_ = await open();

    open_.stream.push({ event: { usageEvent: { totalTokens: 10 } } });
    open_.stream.push({ event: { completionStart: {} } });
    await settle();

    expect(open_.events).toHaveLength(0);

    await open_.shutdown();
  });

  it("ignores a frame that is not an event envelope", async () => {
    const open_ = await open();

    open_.stream.push({ notAnEvent: true });
    await settle();

    expect(open_.events).toHaveLength(0);

    await open_.shutdown();
  });

  // A malformed frame is not worth ending an interview over.
  it("skips an unparseable frame and keeps going", async () => {
    const open_ = await open();

    open_.stream.pushRaw(new TextEncoder().encode("{not json"));
    open_.stream.push(inbound.textOutput("still here"));
    await settle();

    expect(open_.events).toContainEqual({
      kind: "textOutput",
      content: "still here",
    });

    await open_.shutdown();
  });
});

describe("a stream that fails", () => {
  // Bedrock's modelled stream exceptions are not Error instances, so String()
  // yields "[object Object]" and hides the only useful information.
  it("describes a plain object exception by its message", async () => {
    const open_ = await open();

    open_.stream.fail({ message: "ModelStreamErrorException: upstream died" });
    await settle(50);

    expect(open_.events).toContainEqual({
      kind: "error",
      message: "ModelStreamErrorException: upstream died",
    });
  });

  it("describes a real Error by name and message", async () => {
    const open_ = await open();

    open_.stream.fail(new TypeError("bad chunk"));
    await settle(50);

    expect(open_.events).toContainEqual({
      kind: "error",
      message: "TypeError: bad chunk",
    });
  });

  // Every exit path must reach close(), or the stream keeps billing.
  it("closes itself when the stream ends", async () => {
    const open_ = await open();

    open_.stream.end();
    await settle(400);

    expect(open_.closes).toEqual(["stream ended"]);
    expect(open_.session.isActive).toBe(false);
  });
});
