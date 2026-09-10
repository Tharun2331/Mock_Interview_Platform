import { describe, expect, it } from "bun:test";
import { ExchangeBuffer } from "../../lib/exchangeBuffer";

// The bug this class exists to prevent: Sonic emits a FINAL user transcript per
// sentence *fragment*, not per answer. Flushing on each one turned a single
// spoken answer into eight DynamoDB items — the first with a question attached
// and the rest with none. Roughly 40x the writes, and a transcript the
// Evaluator cannot score.
//
// The tests below replay fragment sequences against the buffer, which is the
// same way the fix was proven rather than assumed.

describe("ExchangeBuffer", () => {
  describe("the fragmentation bug", () => {
    it("merges every answer fragment into one exchange", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Tell me about the order pipeline.");

      // One spoken answer, as Sonic actually delivers it.
      for (const fragment of [
        "So we had a monolith.",
        "It was getting hard to deploy.",
        "We split the order flow out first.",
        "Kafka coordinated the state transitions.",
        "Postgres held the durable state.",
      ]) {
        buffer.appendAnswer(fragment);
      }

      const exchange = buffer.take();

      expect(exchange).not.toBeNull();
      expect(exchange?.transcript).toBe(
        "So we had a monolith. It was getting hard to deploy. We split the order flow out first. Kafka coordinated the state transitions. Postgres held the durable state."
      );
    });

    // Replays the event order routes/interview.ts actually sees: the
    // interviewer speaks, the candidate answers in fragments, the interviewer
    // speaks again. That second question is the only signal in the stream that
    // means "the candidate is done", and it is the sole flush boundary.
    it("produces one exchange per turn, not one per fragment", () => {
      const buffer = new ExchangeBuffer();
      const taken: string[] = [];

      buffer.appendQuestion("Tell me about the order pipeline.");
      for (const fragment of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
        buffer.appendAnswer(fragment);
      }

      // Interviewer starts speaking again — the caller flushes here, and only
      // here. The eight-fragment answer must survive as one item.
      const first = buffer.take();
      if (first !== null) taken.push(first.transcript);
      buffer.appendQuestion("And how did you test it?");
      buffer.appendAnswer("Contract tests on the consumer.");

      const second = buffer.take();
      if (second !== null) taken.push(second.transcript);

      expect(taken).toEqual([
        "a b c d e f g h",
        "Contract tests on the consumer.",
      ]);
    });
  });

  describe("take", () => {
    // The interviewer's opening turn: a question has been asked, the candidate
    // has not said anything yet.
    it("returns null before the candidate has answered", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Tell me about yourself.");

      expect(buffer.take()).toBeNull();
    });

    it("returns null when the only answer content is whitespace", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Q");
      buffer.appendAnswer("   ");
      buffer.appendAnswer("\t\n");

      expect(buffer.hasAnswer).toBe(false);
      expect(buffer.take()).toBeNull();
    });

    it("joins multi-block questions with spaces", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Walk me through the pipeline.");
      buffer.appendQuestion("Start from the API boundary.");
      buffer.appendAnswer("Sure.");

      expect(buffer.take()?.questionText).toBe(
        "Walk me through the pipeline. Start from the API boundary."
      );
    });

    it("trims each fragment before joining", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("  Question.  ");
      buffer.appendAnswer("  first  ");
      buffer.appendAnswer("  second  ");

      const exchange = buffer.take();

      expect(exchange?.questionText).toBe("Question.");
      expect(exchange?.transcript).toBe("first second");
    });

    it("drops empty fragments rather than emitting double spaces", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Q");
      buffer.appendAnswer("first");
      buffer.appendAnswer("   ");
      buffer.appendAnswer("second");

      expect(buffer.take()?.transcript).toBe("first second");
    });

    it("emits an ISO askedAt", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendAnswer("answer");

      const exchange = buffer.take();

      expect(exchange).not.toBeNull();
      // Must satisfy the z.iso.datetime() on SessionAnswerSchema.
      expect(exchange?.askedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("reset after take", () => {
    it("issues a fresh question id for each exchange", () => {
      const buffer = new ExchangeBuffer();

      buffer.appendAnswer("first answer");
      const first = buffer.take();

      buffer.appendAnswer("second answer");
      const second = buffer.take();

      expect(first?.questionId).toBeDefined();
      expect(second?.questionId).toBeDefined();
      expect(first?.questionId).not.toBe(second?.questionId);
    });

    it("does not carry question or answer text into the next exchange", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("First question.");
      buffer.appendAnswer("First answer.");
      buffer.take();

      buffer.appendQuestion("Second question.");
      buffer.appendAnswer("Second answer.");
      const second = buffer.take();

      expect(second?.questionText).toBe("Second question.");
      expect(second?.transcript).toBe("Second answer.");
    });

    it("returns null again immediately after a successful take", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendAnswer("answer");

      expect(buffer.take()).not.toBeNull();
      expect(buffer.take()).toBeNull();
    });

    // take(now) sets the next exchange's askedAt to `now`, so the following
    // duration is exactly computable — no wall-clock tolerance needed.
    it("clocks the next exchange from the moment the previous one closed", () => {
      const buffer = new ExchangeBuffer();
      const closedAt = 1_800_000_000_000;

      buffer.appendAnswer("first");
      buffer.take(closedAt);

      buffer.appendAnswer("second");
      const second = buffer.take(closedAt + 42_000);

      expect(second?.durationMs).toBe(42_000);
      expect(second?.askedAt).toBe(new Date(closedAt).toISOString());
    });
  });

  describe("barge-in", () => {
    // An answer given over a half-delivered question is not comparable to one
    // given after the whole question, and the Evaluator needs to know which.
    it("records that the candidate interrupted", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Tell me about the —");
      buffer.markInterrupted();
      buffer.appendAnswer("Sorry, go on.");

      expect(buffer.take()?.interrupted).toBe(true);
    });

    it("defaults to not interrupted", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendAnswer("answer");

      expect(buffer.take()?.interrupted).toBe(false);
    });

    it("clears the flag for the next exchange", () => {
      const buffer = new ExchangeBuffer();
      buffer.markInterrupted();
      buffer.appendAnswer("first");
      expect(buffer.take()?.interrupted).toBe(true);

      buffer.appendAnswer("second");
      expect(buffer.take()?.interrupted).toBe(false);
    });

    // markInterrupted before any answer must not manufacture an exchange —
    // the barge-in flag is metadata, not content.
    it("does not by itself make an exchange takeable", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Q");
      buffer.markInterrupted();

      expect(buffer.take()).toBeNull();
    });
  });

  describe("hasAnswer", () => {
    it("is false on a fresh buffer", () => {
      expect(new ExchangeBuffer().hasAnswer).toBe(false);
    });

    it("is false when only a question has been appended", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendQuestion("Q");

      expect(buffer.hasAnswer).toBe(false);
    });

    it("is true once any non-empty answer fragment arrives", () => {
      const buffer = new ExchangeBuffer();
      buffer.appendAnswer("   ");
      expect(buffer.hasAnswer).toBe(false);

      buffer.appendAnswer("something");
      expect(buffer.hasAnswer).toBe(true);
    });
  });
});
