import { describe, expect, it } from "bun:test";
import { isInterruptionSentinel } from "../../routes/interview";

// Sonic signals a barge-in by emitting `{"interrupted":true}` as an assistant
// textOutput — a control signal on the same channel as speech.
//
// In a measured session it did three things at once: it was shown to the
// candidate as something the interviewer said, it was appended into the
// question text the Evaluator later scored against, and it triggered an
// exchange boundary.

describe("the barge-in sentinel", () => {
  it.each([
    '{"interrupted":true}',
    '{ "interrupted" : true }',
    '{"interrupted": true}',
    '\n{"interrupted":true}\n',
  ])("recognises %p whatever the spacing", (content) => {
    expect(isInterruptionSentinel(content)).toBe(true);
  });

  // Parsed rather than matched against the exact string Sonic happens to emit
  // today, so a formatting change upstream does not silently reopen the bug.
  it("recognises it alongside other fields", () => {
    expect(isInterruptionSentinel('{"interrupted":true,"reason":"barge_in"}')).toBe(
      true
    );
  });

  it("does not fire on interrupted:false", () => {
    expect(isInterruptionSentinel('{"interrupted":false}')).toBe(false);
  });
});

describe("actual speech is never mistaken for it", () => {
  it.each([
    "Thanks for that. Let's dig into the Brainly platform.",
    "So the architecture is a React frontend talking to Express.",
    "Can you walk me through how you handled authentication?",
    "",
    "   ",
  ])("passes %p through", (content) => {
    expect(isInterruptionSentinel(content)).toBe(false);
  });

  // A sentence that merely opens with a brace is speech, not a signal — and
  // must not be handed to JSON.parse as though it were.
  it("passes through a sentence that starts with a brace", () => {
    expect(isInterruptionSentinel("{ is the opening brace in JSON")).toBe(false);
  });

  // The length cap is what keeps a long answer off JSON.parse entirely.
  it("does not attempt to parse a long utterance", () => {
    const long = `{${"a".repeat(200)}`;
    expect(isInterruptionSentinel(long)).toBe(false);
  });

  it("does not fire on unrelated JSON", () => {
    expect(isInterruptionSentinel('{"role":"ASSISTANT"}')).toBe(false);
  });
});
