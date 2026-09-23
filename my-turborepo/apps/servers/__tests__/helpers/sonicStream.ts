// Fakes the two halves of a Nova 2 Sonic bidirectional stream.
//
// Deliberately NOT a `mock.module` of lib/sonic. That module is the subject of
// sonicSession.test.ts and sonicConversation.test.ts, and routes/interview.ts
// drives the real SonicConversation — stubbing it would delete the renewal
// ordering, the closing sequence and the event dispatch from the suite while
// appearing to cover them. Both sides mock `BedrockRuntimeClient` at the leaf
// instead, which is the rule bedrockStub.ts exists to encode.
//
// Nothing here registers a module mock or a client mock; it is plain helpers
// over whatever the test's own `mockClient` captured.

/** The chunk shape the SDK hands to `SonicSession.consume`. */
type StreamChunk = { chunk?: { bytes?: Uint8Array } };

function encode(event: unknown): StreamChunk {
  return { chunk: { bytes: new TextEncoder().encode(JSON.stringify(event)) } };
}

/**
 * The INBOUND half — what Bedrock sends back.
 *
 * Controllable rather than a fixed array because the interesting cases are
 * sequenced against the session's own lifetime: a tool result answered
 * mid-stream, an error raised after some events have already landed, a stream
 * that ends while an exchange is half-assembled. A plain generator can only
 * express "here is everything, in order, immediately".
 */
export class FakeSonicStream implements AsyncIterable<StreamChunk> {
  private readonly pending: StreamChunk[] = [];
  private readonly waiting: ((value: IteratorResult<StreamChunk>) => void)[] =
    [];
  private failure: unknown = null;
  private ended = false;

  /** Emit one Sonic event envelope, e.g. `{ event: { textOutput: {...} } }`. */
  push(event: unknown): void {
    if (this.ended) return;
    const chunk = encode(event);
    const waiter = this.waiting.shift();
    if (waiter !== undefined) waiter({ value: chunk, done: false });
    else this.pending.push(chunk);
  }

  /** A frame that is not valid JSON. `consume` must skip it, not die on it. */
  pushRaw(bytes: Uint8Array): void {
    if (this.ended) return;
    const chunk: StreamChunk = { chunk: { bytes } };
    const waiter = this.waiting.shift();
    if (waiter !== undefined) waiter({ value: chunk, done: false });
    else this.pending.push(chunk);
  }

  /** Make the iterator throw, which is how a mid-stream Bedrock failure looks. */
  fail(error: unknown): void {
    this.failure = error;
    this.ended = true;
    const waiter = this.waiting.shift();
    // Released with done so the loop exits; the throw happens in the iterator.
    if (waiter !== undefined) waiter({ value: undefined, done: true });
  }

  /** Close cleanly — the stream reached its end without error. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting) waiter({ value: undefined, done: true });
    this.waiting.length = 0;
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamChunk> {
    while (true) {
      const queued = this.pending.shift();
      if (queued !== undefined) {
        yield queued;
        continue;
      }
      if (this.failure !== null) throw this.failure;
      if (this.ended) return;

      const next = await new Promise<IteratorResult<StreamChunk>>((resolve) =>
        this.waiting.push(resolve),
      );
      if (next.done) {
        if (this.failure !== null) throw this.failure;
        return;
      }
      yield next.value;
    }
  }
}

/** One decoded outbound envelope, plus the single event key it carries. */
export type OutboundEvent = { name: string; payload: Record<string, unknown> };

export type OutboundTap = {
  /** Envelopes seen so far, in order. Grows as the session sends. */
  readonly events: OutboundEvent[];
  /** Just the event names, which is what most ordering assertions want. */
  names: () => string[];
  /** Every envelope of one kind — `contentStart` arrives many times. */
  ofName: (name: string) => Record<string, unknown>[];
  /** Resolves once the session closes its queue. */
  done: Promise<void>;
};

/**
 * The OUTBOUND half — what the session sends to Bedrock.
 *
 * Drains concurrently, the way the real SDK does. That matters: the queue only
 * reports `depth` for events nobody has pulled, so a test asserting
 * backpressure must NOT tap it. Everything else should, because a tap is the
 * only way to see the protocol the session actually speaks.
 */
export function tapOutbound(body: unknown): OutboundTap {
  const events: OutboundEvent[] = [];

  const done = (async () => {
    for await (const chunk of body as AsyncIterable<StreamChunk>) {
      const bytes = chunk.chunk?.bytes;
      if (bytes === undefined) continue;

      const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("event" in parsed)
      ) {
        continue;
      }
      const envelope = (parsed as { event: Record<string, unknown> }).event;
      const name = Object.keys(envelope)[0];
      if (name === undefined) continue;

      events.push({
        name,
        payload: (envelope[name] ?? {}) as Record<string, unknown>,
      });
    }
  })();

  return {
    events,
    names: () => events.map((event) => event.name),
    ofName: (name) =>
      events
        .filter((event) => event.name === name)
        .map((event) => event.payload),
    done,
  };
}

/**
 * Lets queued microtasks and timers run.
 *
 * The session pushes synchronously but the tap consumes asynchronously, so an
 * assertion made immediately after `sendAudio` reads an array that has not
 * caught up. This is the seam, named, rather than a bare `setTimeout` repeated
 * at twenty call sites.
 */
export function settle(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Sonic's own envelope shapes, so tests read as the protocol rather than as
 *  object literals. */
export const inbound = {
  contentStart: (args: {
    role: string;
    type: string;
    generationStage?: string;
  }) => ({
    event: {
      contentStart: {
        role: args.role,
        type: args.type,
        ...(args.generationStage === undefined
          ? {}
          : {
              additionalModelFields: JSON.stringify({
                generationStage: args.generationStage,
              }),
            }),
      },
    },
  }),
  textOutput: (content: string) => ({ event: { textOutput: { content } } }),
  audioOutput: (base64: string) => ({
    event: { audioOutput: { content: base64 } },
  }),
  toolUse: (args: {
    toolName: string;
    toolUseId: string;
    content: string;
  }) => ({
    event: { toolUse: { ...args } },
  }),
  contentEnd: (args: { type: string; stopReason?: string }) => ({
    event: {
      contentEnd: {
        type: args.type,
        ...(args.stopReason === undefined
          ? {}
          : { stopReason: args.stopReason }),
      },
    },
  }),
  completionEnd: (stopReason?: string) => ({
    event: {
      completionEnd: stopReason === undefined ? {} : { stopReason },
    },
  }),
} as const;
