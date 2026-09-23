import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { mockClient } from "aws-sdk-client-mock";
import { SONIC } from "../../lib/constants";
import type { CompletedExchange } from "../../lib/exchangeBuffer";
import { FakeSonicStream, settle, tapOutbound } from "../helpers/sonicStream";

// One interview across however many Sonic streams it takes.
//
// Bedrock closes a bidirectional stream after roughly 8 minutes — measured at
// 7m19s of real conversation — and that is not configurable, so a 40-minute
// plan cannot run on one stream. `renewAfterMs` exists precisely so this
// handover can be exercised in milliseconds rather than only after six and a
// half minutes: a handover that cannot be tested is a handover nobody has seen
// work.

const bedrock = mockClient(BedrockRuntimeClient);
const { SonicConversation } = await import("../../lib/sonic");

afterAll(() => bedrock.restore());

// One fresh inbound stream per open, so a renewal gets its own rather than
// re-reading the exhausted one.
let streams: FakeSonicStream[] = [];

beforeEach(() => {
  bedrock.reset();
  streams = [];
  bedrock.on(InvokeModelWithBidirectionalStreamCommand).callsFake(() => {
    const stream = new FakeSonicStream();
    streams.push(stream);
    return { body: stream };
  });
});

function streamCount(): number {
  return bedrock.commandCalls(InvokeModelWithBidirectionalStreamCommand).length;
}

// The OUTBOUND queue of the nth stream. Read late on purpose: nothing drains
// it, so every event the session sent is still queued and arrives in order.
function outboundOf(index: number) {
  const body = bedrock.commandCalls(InvokeModelWithBidirectionalStreamCommand)[
    index
  ]?.args[0].input.body;
  return tapOutbound(body);
}

function exchange(question: string, answer: string): CompletedExchange {
  return {
    questionId: `q-${question}`,
    questionText: question,
    transcript: answer,
    askedAt: "2026-09-16T10:00:00.000Z",
    durationMs: 1000,
    interrupted: false,
  };
}

type Built = {
  conversation: InstanceType<typeof SonicConversation>;
  closes: string[];
  errors: string[];
  renewals: number[];
  prompts: string[];
};

function build(
  args: {
    renewAfterMs?: number;
    getHistory?: () => readonly CompletedExchange[];
    systemPrompt?: string | (() => string);
  } = {},
): Built {
  const closes: string[] = [];
  const errors: string[] = [];
  const renewals: number[] = [];
  const prompts: string[] = [];

  const conversation = new SonicConversation({
    systemPrompt:
      args.systemPrompt ??
      (() => {
        const prompt = `PROMPT ${prompts.length}`;
        prompts.push(prompt);
        return prompt;
      }),
    tools: [],
    getHistory: args.getHistory ?? (() => []),
    onEvent: (event) => {
      if (event.kind === "error") errors.push(event.message);
    },
    onClose: (reason) => closes.push(reason),
    onRenew: (count) => renewals.push(count),
    ...(args.renewAfterMs === undefined
      ? {}
      : { renewAfterMs: args.renewAfterMs }),
  });

  return { conversation, closes, errors, renewals, prompts };
}

describe("a conversation on one stream", () => {
  it("opens a stream on start", async () => {
    const built = build();
    await built.conversation.start();

    expect(streamCount()).toBe(1);

    await built.conversation.close("done");
  });

  it("has renewed nothing yet", async () => {
    const built = build();
    await built.conversation.start();

    expect(built.conversation.renewalCount).toBe(0);

    await built.conversation.close("done");
  });

  it("reports the close reason once", async () => {
    const built = build();
    await built.conversation.start();

    await built.conversation.close("candidate ended interview");

    expect(built.closes).toEqual(["candidate ended interview"]);
  });

  it("is idempotent on close", async () => {
    const built = build();
    await built.conversation.start();

    await built.conversation.close("first");
    await built.conversation.close("second");

    expect(built.closes).toEqual(["first"]);
  });
});

describe("renewing past the 8-minute ceiling", () => {
  it("opens a replacement stream", async () => {
    const built = build({ renewAfterMs: 30 });
    await built.conversation.start();

    await settle(500);

    expect(streamCount()).toBe(2);
    expect(built.conversation.renewalCount).toBe(1);

    await built.conversation.close("done");
  });

  it("tells the caller a renewal happened", async () => {
    const built = build({ renewAfterMs: 30 });
    await built.conversation.start();

    await settle(500);

    expect(built.renewals).toEqual([1]);

    await built.conversation.close("done");
  });

  // THE bug this class was rewritten for.
  //
  // The old stream is closed BEFORE `renewing` drops. Reversed, its onClose
  // fires while the flag is already false, the guard in open() lets it through,
  // and the route treats a routine handover as the interview ending — killing
  // every session at its first renewal. It surfaced as a stray "closed: renewed"
  // that would have been fatal in the route.
  it("does not report a close when a stream is swapped", async () => {
    const built = build({ renewAfterMs: 30 });
    await built.conversation.start();

    await settle(600);

    expect(built.closes).toEqual([]);

    await built.conversation.close("done");
    expect(built.closes).toEqual(["done"]);
  });

  // A function, not a string, so each stream is briefed with the state of the
  // interview at the moment it opens. Elapsed time is the one thing in the
  // prompt that is false by the second renewal if fixed at construction.
  it("rebuilds the system prompt for the replacement", async () => {
    const built = build({ renewAfterMs: 30 });
    await built.conversation.start();

    await settle(500);

    expect(built.prompts).toEqual(["PROMPT 0", "PROMPT 1"]);

    const second = outboundOf(1);
    await settle();
    expect(second.ofName("textInput")[0]?.content).toBe("PROMPT 1");

    await built.conversation.close("done");
  });

  // Replaying everything would grow the prompt without bound across a long
  // interview; the session brief already carries the candidate's background.
  it("replays only the most recent exchanges", async () => {
    const history: CompletedExchange[] = Array.from(
      { length: SONIC.MAX_REPLAYED_EXCHANGES + 4 },
      (_, index) => exchange(`Question ${index}?`, `Answer ${index}.`),
    );

    const built = build({ renewAfterMs: 30, getHistory: () => history });
    await built.conversation.start();
    built.conversation.kickoff("[kickoff]");

    await settle(500);

    const second = outboundOf(1);
    await settle();
    const contents = second.ofName("textInput").map((p) => String(p.content));

    // The oldest is dropped; the newest survives.
    expect(contents).not.toContain("Question 0?");
    expect(contents).toContain(`Question ${SONIC.MAX_REPLAYED_EXCHANGES + 3}?`);

    await built.conversation.close("done");
  });

  // Only the FIRST note is kept. The opening turn is a fixed historical fact; a
  // later nudge (the wrap-up) is said mid-conversation, and replaying it as the
  // greeting would tell a fresh stream the interview began with "time is nearly
  // up".
  it("replays the original kickoff, not a later nudge", async () => {
    const built = build({
      renewAfterMs: 60,
      getHistory: () => [exchange("Q?", "A.")],
    });
    await built.conversation.start();

    built.conversation.kickoff("[the candidate has joined]");
    built.conversation.kickoff("[time is nearly up]");

    await settle(500);

    const second = outboundOf(1);
    await settle();
    const contents = second.ofName("textInput").map((p) => String(p.content));

    expect(contents).toContain("[the candidate has joined]");
    expect(contents).not.toContain("[time is nearly up]");

    await built.conversation.close("done");
  });

  it("routes audio to the replacement once it is live", async () => {
    const built = build({ renewAfterMs: 30 });
    await built.conversation.start();

    await settle(500);

    built.conversation.sendAudio(Buffer.from([7, 7, 7]));
    await settle();

    const second = outboundOf(1);
    await settle();
    expect(second.ofName("audioInput")).toHaveLength(1);

    await built.conversation.close("done");
  });

  // Renewal has to be a chain, not a one-off: a 40-minute interview needs five
  // handovers, so the replacement must schedule its own.
  //
  // The interval is deliberately longer than the 300ms close inside renew()'s
  // finally block. Below that, the next timer fires while `renewing` is still
  // true, the guard returns early, and — worth knowing — nothing reschedules,
  // so the chain stops permanently. Unreachable in production, where renewals
  // are 6.5 minutes apart and a close takes 300ms, but it is why this test
  // cannot simply use the smallest interval that runs fast.
  it("renews again after the replacement", async () => {
    const built = build({ renewAfterMs: 400 });
    await built.conversation.start();

    await settle(1500);

    expect(built.conversation.renewalCount).toBeGreaterThanOrEqual(2);

    await built.conversation.close("done");
  });
});

describe("a renewal that fails", () => {
  // The old stream is still open and still works until Bedrock closes it, so
  // the interview continues on borrowed time rather than ending here.
  it("reports the failure without ending the conversation", async () => {
    const built = build({ renewAfterMs: 30 });
    await built.conversation.start();

    // Only the replacement fails.
    bedrock
      .on(InvokeModelWithBidirectionalStreamCommand)
      .rejects(new Error("ThrottlingException"));

    await settle(500);

    expect(
      built.errors.some((message) => message.includes("renewal failed")),
    ).toBe(true);
    expect(built.closes).toEqual([]);

    await built.conversation.close("done");
  });

  it("keeps the old stream serving audio", async () => {
    const built = build({ renewAfterMs: 30 });
    await built.conversation.start();

    bedrock
      .on(InvokeModelWithBidirectionalStreamCommand)
      .rejects(new Error("ThrottlingException"));

    await settle(500);

    built.conversation.sendAudio(Buffer.from([1, 2]));
    await settle();

    const first = outboundOf(0);
    await settle();
    expect(first.ofName("audioInput")).toHaveLength(1);

    await built.conversation.close("done");
  });
});

describe("closing mid-renewal", () => {
  // A close that lands while a swap is in flight must still be final — the
  // renewal timer is cleared, so nothing reopens behind it.
  it("stops renewing once closed", async () => {
    const built = build({ renewAfterMs: 40 });
    await built.conversation.start();

    await built.conversation.close("candidate ended interview");
    const afterClose = streamCount();

    await settle(300);

    expect(streamCount()).toBe(afterClose);
    expect(built.closes).toEqual(["candidate ended interview"]);
  });
});
