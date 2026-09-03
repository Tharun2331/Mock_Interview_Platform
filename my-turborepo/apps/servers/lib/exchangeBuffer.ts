import { ulid } from "ulid";

// Assembles one question-and-answer exchange from the Sonic event stream.
//
// Extracted from routes/interview.ts and kept pure so it can be replayed
// against a recorded event sequence — which is how the fragmentation bug below
// was proven fixed rather than assumed.
//
// The bug worth understanding before editing this: Sonic emits a FINAL USER
// transcript per *sentence fragment*, not per answer. An earlier version
// flushed on each one, which turned a single spoken answer into eight DynamoDB
// items — the first with a question attached and the rest with none, each
// holding a few words. Roughly 40x the writes, and a transcript the Evaluator
// cannot score.
//
// The real boundary is the interviewer starting to speak again. That is the
// only signal in the stream that means "the candidate is done".
export type CompletedExchange = {
  questionId: string;
  questionText: string;
  transcript: string;
  askedAt: string;
  durationMs: number;
  interrupted: boolean;
};

export class ExchangeBuffer {
  private questionId = ulid();
  private questionParts: string[] = [];
  private answerParts: string[] = [];
  private askedAt = Date.now();
  private interrupted = false;

  // Sonic emits a question as several sentence-level blocks, so they are joined
  // rather than replaced.
  appendQuestion(text: string): void {
    this.questionParts.push(text.trim());
  }

  appendAnswer(text: string): void {
    this.answerParts.push(text.trim());
  }

  // Barge-in. Recorded on the exchange because an answer given over a
  // half-delivered question is not comparable to one given after the whole
  // question, and the Evaluator needs to know which it is scoring.
  markInterrupted(): void {
    this.interrupted = true;
  }

  get hasAnswer(): boolean {
    return this.answerParts.some((part) => part.length > 0);
  }

  // Returns the completed exchange and resets for the next one, or null if
  // there is no answer yet — which is the case for the interviewer's opening
  // turn, before the candidate has said anything.
  take(now: number = Date.now()): CompletedExchange | null {
    if (!this.hasAnswer) return null;

    const exchange: CompletedExchange = {
      questionId: this.questionId,
      questionText: this.questionParts.filter(Boolean).join(" "),
      transcript: this.answerParts.filter(Boolean).join(" "),
      askedAt: new Date(this.askedAt).toISOString(),
      durationMs: now - this.askedAt,
      interrupted: this.interrupted,
    };

    this.questionId = ulid();
    this.questionParts = [];
    this.answerParts = [];
    this.askedAt = now;
    this.interrupted = false;

    return exchange;
  }
}
