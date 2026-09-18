import { ulid } from "ulid";

// Assembles one question-and-answer exchange from the Sonic event stream.
//
// Extracted from routes/interview.ts and kept pure so it can be replayed
// against a recorded event sequence — which is how the fragmentation bug below
// was proven fixed rather than assumed.
//
// The first bug worth understanding: Sonic emits a FINAL USER transcript per
// *sentence fragment*, not per answer. An earlier version flushed on each one,
// which turned a single spoken answer into eight DynamoDB items — the first
// with a question attached and the rest with none, each holding a few words.
// Roughly 40x the writes, and a transcript the Evaluator cannot score.
//
// The second, found in a real session: the boundary is the interviewer
// FINISHING a question, not starting one. Sonic takes its turn after about two
// seconds of silence, which is well inside a candidate's thinking pause — so it
// would start a new question, the candidate would carry on with the answer they
// were already giving, and that continuation was filed under the question that
// had just started. The measured result was the tail of an introduction stored
// against "tell me about the Brainly platform", scored 2/10 for correctness,
// and coaching that told the candidate they had derailed. They had not; the
// buffer had.
//
// So a question spoken while an answer is already pending accumulates as the
// NEXT question, and the exchange only closes when the interviewer's turn
// actually ends. A turn the candidate talks over never closes one — the
// question was not finished being asked, and the words that follow belong to
// what the candidate was already saying.
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
  // The question currently being spoken, when an answer to the previous one is
  // already in hand. Held apart until the interviewer's turn ends, so a
  // question the candidate talks over cannot claim their continuing speech.
  private pendingQuestionParts: string[] = [];
  private answerParts: string[] = [];
  private askedAt = Date.now();
  private interrupted = false;

  // Whether the interviewer's turn has ended since the current question started
  // accumulating. Set by noteTurnEnded, cleared the moment new question text
  // arrives — so it marks a boundary rather than a state.
  private questionTurnClosed = false;

  // Sonic emits a question as several sentence-level blocks, so they are joined
  // rather than replaced.
  appendQuestion(text: string): void {
    const trimmed = text.trim();
    // Once the candidate has answered, anything the interviewer says is the
    // next question rather than more of the current one.
    if (this.hasAnswer) {
      this.pendingQuestionParts.push(trimmed);
      return;
    }

    // A SECOND complete turn with no answer between them. The candidate never
    // answered the first question, so it was abandoned — and joining the two
    // produces a "question" no answer could ever match.
    //
    // This is what produced the worst record in the dev table: a Terraform
    // question, a "one quick final question" about security, and a sign-off
    // repeated twice, all stored as one questionText against the transcript
    // "thank you have a good one" — then scored 0/0/0 with coaching that the
    // candidate had missed an entire question they were never given room to
    // answer.
    //
    // Replacing keeps the question the candidate was actually responding to.
    // The abandoned one is logged rather than stored: it was never answered,
    // so there is no exchange to file it under.
    if (this.questionTurnClosed && this.questionParts.length > 0) {
      this.abandonedQuestions += 1;
      this.questionParts = [];
      // The clock restarts with the question that replaced it, or durationMs
      // would measure from a question nobody answered.
      this.askedAt = Date.now();
    }

    this.questionTurnClosed = false;
    this.questionParts.push(trimmed);
  }

  /** How many questions the interviewer asked and moved on from without an
   *  answer. Read only for logging — a non-zero count is the interviewer
   *  talking over its own pauses. */
  abandonedQuestions = 0;

  // The interviewer stopped speaking. Called on every turn end, including the
  // ones that do not close an exchange.
  noteTurnEnded(): void {
    this.questionTurnClosed = true;
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

  // Whether the interviewer finishing its turn closes an exchange.
  //
  // Both halves are required. A pending question with no answer is the
  // interviewer still setting up — several turns before the candidate has said
  // anything — and an answer with no pending question means nobody has asked
  // the next one yet.
  get isComplete(): boolean {
    return this.pendingQuestionParts.length > 0 && this.hasAnswer;
  }

  // Discards a question the candidate talked over.
  //
  // Deliberately NOT merged into the next one. The interviewer re-asks after
  // being interrupted, so keeping the fragment would prefix every re-asked
  // question with the half-sentence that preceded it — and that text is what
  // the Evaluator is told the candidate was answering.
  dropPendingQuestion(): void {
    this.pendingQuestionParts = [];
  }

  // Returns the completed exchange and rolls forward, or null if there is no
  // answer yet — the case for the interviewer's opening turn, before the
  // candidate has said anything.
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
    // The question that was being asked becomes the current one, rather than
    // being thrown away — it is what the next answer responds to.
    this.questionParts = this.pendingQuestionParts;
    this.pendingQuestionParts = [];
    this.answerParts = [];
    this.askedAt = now;
    this.interrupted = false;
    // The question that just became current arrived on a turn that has already
    // ended, and the flag is still set from it. Cleared so the NEXT turn is the
    // one that can abandon it — otherwise a second sentence of the very same
    // question would count as a whole new unanswered one.
    this.questionTurnClosed = false;

    return exchange;
  }
}
