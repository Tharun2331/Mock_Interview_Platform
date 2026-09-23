import { describe, expect, it } from "bun:test";
import { toQuestionType } from "../../agents/mockInterview";

// The translation between the interviewer's vocabulary and everything
// downstream.
//
// Worth its own file because of what it fixes: `questionType` was hardcoded to
// "technical" on every recorded answer, so every EVAL# row in the dev table
// describes a technical question regardless of what was asked. The signal was
// there the whole time — `logExchange` reports `exchangeType` on every call —
// and the handler simply never parsed its input.
//
// Two vocabularies, deliberately not merged. `exchangeType` describes the
// CONVERSATIONAL move (opening, following up, changing subject), which is what
// the interviewer needs to pace itself. `questionType` describes what a
// question TESTS, which is what the Evaluator gates on and the Coach reports
// against.

describe("toQuestionType", () => {
  it("maps behavioural directly", () => {
    expect(toQuestionType("behavioural")).toBe("behavioural");
  });

  // The one rename: camelCase on the wire, snake_case in the stored enum.
  it("renames roleSpecific to the stored spelling", () => {
    expect(toQuestionType("roleSpecific")).toBe("role_specific");
  });

  // Technical is the residual bucket rather than a claim. "Tell me about
  // yourself" is an opening, and none of the three categories describes it
  // well — but it has to land somewhere, and this is where it landed before
  // any of this existed.
  it.each(["opening", "transition"] as const)(
    "falls back to technical for %s",
    (exchangeType) => {
      expect(toQuestionType(exchangeType)).toBe("technical");
    },
  );
});

// The case the `previous` parameter exists for, and the reason this is not a
// plain lookup table.
describe("a follow-up", () => {
  it("inherits the category of what it followed", () => {
    expect(toQuestionType("followup", "behavioural")).toBe("behavioural");
    expect(toQuestionType("followup", "role_specific")).toBe("role_specific");
  });

  // The failure this prevents: "can you say more about that?" after a
  // behavioural question is still behavioural. Scored as technical, the
  // Evaluator would gate on correctness and depth and mark a candidate down
  // for not citing an algorithm in a story about disagreeing with a colleague.
  it("does not silently become technical after a behavioural question", () => {
    expect(toQuestionType("followup", "behavioural")).not.toBe("technical");
  });

  it("defaults to technical when nothing preceded it", () => {
    expect(toQuestionType("followup")).toBe("technical");
  });

  // A chain of follow-ups carries the category all the way down rather than
  // decaying to the default after the first one.
  it("carries the category across a chain", () => {
    let current = toQuestionType("behavioural");
    for (let index = 0; index < 4; index += 1) {
      current = toQuestionType("followup", current);
    }
    expect(current).toBe("behavioural");
  });

  // But a genuine change of subject resets it — a follow-up inherits, a new
  // question does not.
  it("is reset by an explicit new category", () => {
    const afterBehavioural = toQuestionType("followup", "behavioural");
    expect(toQuestionType("roleSpecific", afterBehavioural)).toBe(
      "role_specific",
    );
  });
});
