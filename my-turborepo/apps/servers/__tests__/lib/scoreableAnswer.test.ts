import { describe, expect, it } from "bun:test";
import { classifyAnswer, isScoreableAnswer } from "../../lib/scoreableAnswer";

// Every "not scoreable" case below is a real transcript from a measured
// session, together with the nonsense it was scored as.

describe("closing acknowledgements", () => {
  // Scored 0/0/0 with "a senior engineer would leave with a memorable line",
  // as if a sign-off were a failed answer.
  it.each([
    "thank you",
    "Thank you.",
    "thanks",
    "thank you so much",
    "okay thank you",
    "sure thanks",
    "thank you very much",
    "thanks for your time",
  ])("does not score %p", (transcript) => {
    expect(classifyAnswer(transcript)).toEqual({
      scoreable: false,
      reason: "courtesy",
    });
  });

  // A real answer may thank the interviewer on its way past. Only an utterance
  // that is ENTIRELY courtesy is skipped.
  it("still scores an answer that opens with thanks", () => {
    expect(
      isScoreableAnswer(
        "thanks so the way i would approach that is to wrap both writes in a transaction so either both land or neither does"
      )
    ).toBe(true);
  });

  it("still scores an answer that ends with thanks", () => {
    expect(
      isScoreableAnswer(
        "i used redux for the shared state and memoized the dropdown with react memo thank you"
      )
    ).toBe(true);
  });
});

describe("requests to hear the question again", () => {
  // Scored 0/0/0 with "you missed the question entirely, which is a critical
  // failure for a senior role" — for asking to hear it again.
  it.each([
    "i didn't get your question could you please repeat",
    "that's a good question could you please repeat it",
    "could you please repeat it again",
    "can you repeat that",
    "sorry could you say that again",
    "could you repeat the question",
    "come again",
    "one more time please",
    "i didn't catch that",
  ])("does not score %p", (transcript) => {
    expect(classifyAnswer(transcript)).toEqual({
      scoreable: false,
      reason: "clarification",
    });
  });

  // Regression pins. An earlier version of the pattern made every group
  // optional, which collapsed it to a bare \b(repeat|say)\b — these six real
  // answers were all skipped by it. Filtering a genuine answer is far worse
  // than scoring a pleasantry: it silently removes feedback the candidate
  // earned and lowers the denominator with it.
  it.each([
    "so i would say that we should use redux here",
    "i would say the main tradeoff is latency",
    "say for example a user selects a tax file",
    "i had to repeat the migration for each table",
    "what i say to the team is always profile first",
    "we repeat the request with exponential backoff",
  ])("scores %p — contains repeat/say but is not a request", (transcript) => {
    expect(isScoreableAnswer(transcript)).toBe(true);
  });

  // A clarification inside a real answer is still an answer.
  it("scores an answer that asks about one part while answering another", () => {
    expect(
      isScoreableAnswer(
        "could you repeat the second part but on the first one what i did was wrap the consumer in a retry with exponential backoff so a transient failure did not drop the message"
      )
    ).toBe(true);
  });
});

// The line this filter must not cross. These are answers: the candidate
// engaged and could not answer, which is precisely the signal an interview
// exists to surface. Filtering them would flatter the score and hide the thing
// the candidate most needs to see.
describe("admissions of not knowing are still scored", () => {
  it.each([
    "i don't know",
    "i'm not too sure",
    "i'm not too sure about it",
    "i don't know let's move to the next question",
    "i don't know that question could you please move to a different question",
    "i haven't implemented that yet",
    "to be very honest with you this is version one and i haven't implemented key rotation yet",
  ])("scores %p", (transcript) => {
    expect(isScoreableAnswer(transcript)).toBe(true);
  });
});

describe("real answers", () => {
  it.each([
    "sure so initially the system was re rendering unnecessarily so i implemented use callback on the child component functions",
    "so i stored all the tax file ids and the ones which were often used were kept in memory",
    "i used aws ssm parameter store for the credentials and an env file for local development",
  ])("scores %p", (transcript) => {
    expect(isScoreableAnswer(transcript)).toBe(true);
  });

  // A one-word answer is a poor answer, not a non-answer. "the day one" scored
  // 0/0/0 in a real session and that was the correct outcome — the candidate
  // was attempting the question.
  it("scores a very short attempt at the question", () => {
    expect(isScoreableAnswer("the day one")).toBe(true);
    expect(isScoreableAnswer("redux")).toBe(true);
  });
});

// The sound of starting to answer, with no answer in it. Observed as "sure so",
// captured when the interviewer closed the interview while the candidate was
// drawing breath — then scored 0/0/0 with coaching that they should have named
// JWT or OAuth.
describe("abandoned openings", () => {
  it.each([
    "sure so",
    "so",
    "yeah so",
    "okay so",
    "um",
    "uh so",
    "well i",
    "right so",
  ])("does not score %p", (transcript) => {
    expect(classifyAnswer(transcript)).toEqual({
      scoreable: false,
      reason: "opener",
    });
  });

  // The test is whether anything content-bearing was said, not how much. These
  // are poor answers, and a poor answer is scoreable.
  it.each([
    "the day one",
    "redux",
    "sure so redux",
    "yeah we used jwt",
    "um probably lambda",
  ])("still scores %p", (transcript) => {
    expect(isScoreableAnswer(transcript)).toBe(true);
  });
});

describe("normalisation", () => {
  it("is unaffected by punctuation and capitalisation", () => {
    expect(isScoreableAnswer("Thank you!")).toBe(false);
    expect(isScoreableAnswer("THANK YOU")).toBe(false);
    expect(isScoreableAnswer("Could you please repeat that?")).toBe(false);
  });

  it("is unaffected by surrounding whitespace", () => {
    expect(isScoreableAnswer("   thank you   ")).toBe(false);
  });

  it("treats an empty transcript as nothing to score", () => {
    expect(isScoreableAnswer("")).toBe(false);
    expect(isScoreableAnswer("   ")).toBe(false);
  });
});
