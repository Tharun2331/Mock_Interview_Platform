import { describe, expect, it } from "bun:test";
import { ExchangeBuffer } from "../../lib/exchangeBuffer";
import { QUESTIONS_REMAINING, interviewPhase } from "../../lib/interviewClock";
import { classifyAnswer } from "../../lib/scoreableAnswer";

const TEST_SETTINGS = { testMode: false, testTargetMinutes: 6 };

// Everything here is reconstructed from one real session, where the last three
// records were:
//
//   Q: "...Can you describe a scenario where you used Terraform...? Thanks for
//       that. One quick final question: ...security practices...? Once you
//       answer, I'll wrap up... Thank you for your time today, Tarun — it was
//       great speaking with you. Thank you for your time today, Tarun — it was
//       great speaking with you."
//   A: "thank you have a good one"                              -> scored 0/0/0
//
//   Q: "You're welcome! Have a great day as well."
//   A: "how much time is left"                                  -> scored 0/0/0
//
// Three separate defects produced that, and they are tested separately below.

describe("a question the candidate never answered", () => {
  // THE COMPOUND QUESTION WAS NOT ONE MODEL TURN. The buffer joined three
  // interviewer turns because `hasAnswer` stayed false throughout — Sonic takes
  // its turn after about two seconds of silence, so it asked, waited, asked
  // again, then closed, and all of it accumulated into one questionText.
  it("is replaced by the next one rather than joined to it", () => {
    const buffer = new ExchangeBuffer();

    buffer.appendQuestion("Can you describe a Terraform scenario?");
    buffer.noteTurnEnded();
    buffer.appendQuestion("One quick final question: what about security?");
    buffer.noteTurnEnded();
    buffer.appendAnswer("thank you have a good one");
    buffer.appendQuestion("Next question.");

    const exchange = buffer.take();

    expect(exchange?.questionText).toBe(
      "One quick final question: what about security?",
    );
    expect(exchange?.questionText).not.toContain("Terraform");
  });

  it("counts what it abandoned, so the log can say so", () => {
    const buffer = new ExchangeBuffer();

    buffer.appendQuestion("First.");
    buffer.noteTurnEnded();
    buffer.appendQuestion("Second.");
    buffer.noteTurnEnded();
    buffer.appendQuestion("Third.");

    expect(buffer.abandonedQuestions).toBe(2);
  });

  // The behaviour that must NOT change. Sonic emits one question as several
  // sentence-level blocks within a single turn, and joining those is the whole
  // reason appendQuestion accumulates.
  it("does not split a question that arrives as several blocks in one turn", () => {
    const buffer = new ExchangeBuffer();

    buffer.appendQuestion("Thanks for that.");
    buffer.appendQuestion("Now, how did you handle retries?");
    buffer.noteTurnEnded();
    buffer.appendAnswer("We used exponential backoff.");
    buffer.appendQuestion("Next.");

    expect(buffer.take()?.questionText).toBe(
      "Thanks for that. Now, how did you handle retries?",
    );
  });

  // A turn that closes an exchange must not also mark the question it rolled
  // forward as abandonable — that one has not had its chance yet.
  it("does not abandon the question that just became current", () => {
    const buffer = new ExchangeBuffer();

    buffer.appendQuestion("First question.");
    buffer.noteTurnEnded();
    buffer.appendAnswer("An answer.");
    buffer.appendQuestion("Second question.");
    buffer.take();

    buffer.appendQuestion(" With a follow-on sentence.");

    expect(buffer.abandonedQuestions).toBe(0);
  });

  it("restarts the clock with the question that replaced it", async () => {
    const buffer = new ExchangeBuffer();

    buffer.appendQuestion("Abandoned.");
    buffer.noteTurnEnded();
    await new Promise((resolve) => setTimeout(resolve, 30));
    buffer.appendQuestion("The one they answered.");
    buffer.appendAnswer("An answer.");
    buffer.appendQuestion("Next.");

    const exchange = buffer.take();
    // Measured from the replacement, not from a question nobody heard out.
    expect(exchange?.durationMs).toBeLessThan(30);
  });
});

describe("what reaches the scoring queue", () => {
  // The exact transcript that scored 0/0/0 with coaching about a Terraform
  // question the candidate was never given room to answer. The old pattern
  // allowed "have a good day" and not "have a good one".
  it.each([
    "thank you have a good one",
    "thanks have a great day",
    "thank you so much take care",
    "thanks, you too",
    "have a good one",
    "cheers bye",
  ])("skips the sign-off %p", (transcript) => {
    expect(classifyAnswer(transcript)).toEqual({
      scoreable: false,
      reason: "courtesy",
    });
  });

  // The second 0/0/0, coached as "a senior engineer would acknowledge the
  // closing gracefully". It is not an answer — it is the candidate asking the
  // app a question.
  it.each([
    "how much time is left",
    "how much time is remaining",
    "how long do we have",
    "are we done",
    "do you have any other questions",
    "is there anything else",
  ])("skips the session question %p", (transcript) => {
    expect(classifyAnswer(transcript)).toEqual({
      scoreable: false,
      reason: "meta",
    });
  });

  // The bias stays where it was: under-filtering. An unscored pleasantry costs
  // one odd card; a filtered real answer silently deletes feedback the
  // candidate earned.
  it.each([
    "thanks — so the way I would approach that is to shard by tenant",
    "we had about five minutes left on the migration so we rolled back",
    "i do not know",
    "i am not too sure about that",
    "the main tradeoff is latency against consistency",
  ])("still scores the real answer %p", (transcript) => {
    expect(classifyAnswer(transcript).scoreable).toBe(true);
  });
});

// The interviewer was handed two numbers and expected to do the subtraction
// itself on every turn. Naming the conclusion removes that from its job.
describe("the phase the interviewer is told", () => {
  const TARGET = 30;

  it("is core early on", () => {
    expect(interviewPhase(5 * 60_000, TARGET, TEST_SETTINGS)).toBe("core");
  });

  // Production wraps up three minutes out.
  it("is wrap_up once the wrap-up threshold passes", () => {
    expect(interviewPhase(27 * 60_000, TARGET, TEST_SETTINGS)).toBe("wrap_up");
  });

  // And closes one minute out, where there is no question left whatever the
  // wrap-up rule says.
  it("is closing once the final call passes", () => {
    expect(interviewPhase(29 * 60_000, TARGET, TEST_SETTINGS)).toBe("closing");
  });

  it("stays closing past the end", () => {
    expect(interviewPhase(45 * 60_000, TARGET, TEST_SETTINGS)).toBe("closing");
  });

  // The number is what makes "wrap_up" unambiguous: it could otherwise be read
  // as "start closing" or as "you are closing".
  it("carries an explicit question budget", () => {
    expect(QUESTIONS_REMAINING.wrap_up).toBe(1);
    expect(QUESTIONS_REMAINING.closing).toBe(0);
  });

  // Null rather than a large number: a budget the interviewer could count down
  // from would invite it to ration against a figure the plan already sets.
  it("leaves the budget unstated during the core", () => {
    expect(QUESTIONS_REMAINING.core).toBeNull();
  });
});
