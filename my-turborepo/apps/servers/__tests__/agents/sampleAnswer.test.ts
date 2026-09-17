import { beforeEach, describe, expect, it } from "bun:test";
import {
  EVALUATION_LIMITS,
  needsSampleAnswer,
  type EvaluatorInput,
} from "@repo/shared";
// The SHARED Bedrock stub — lib/bedrock is one module and mock.module replaces
// all of it. See the helper's header.
import {
  resetBedrockStub,
  setModelReply,
  lastConverseCall,
  converseCallCount,
} from "../helpers/bedrockStub";

const { runEvaluator } = await import("../../agents/evaluator");

const BASE: EvaluatorInput = {
  questionText: "How do you decide between a message queue and a direct call?",
  questionType: "technical",
  transcript: "Queues are good when you want things to be asynchronous.",
  interrupted: false,
  durationMs: 48_000,
  targetRole: "Backend Engineer",
  startingDifficulty: "mid",
};

const REWRITE =
  "At EY I put the tax export behind SQS because the downstream service took " +
  "eight seconds and the request was timing out.";

function reply(scores: {
  correctness: number;
  clarity: number;
  depth: number;
  sampleAnswer?: string;
}): string {
  return JSON.stringify({
    rationale: "You named the tradeoff but did not ground it in anything you built.",
    ...scores,
  });
}

beforeEach(() => {
  resetBedrockStub();
});

// The gate itself, without a model in the way. Each category pairs the two
// dimensions that actually describe ITS failure mode — a behavioural answer is
// not weak because it lacked depth, and a technical one is not weak because it
// rambled.
describe("needsSampleAnswer", () => {
  describe("technical — correctness and depth", () => {
    it("fires below the threshold", () => {
      expect(
        needsSampleAnswer("technical", { correctness: 4, clarity: 9, depth: 5 })
      ).toBe(true);
    });

    it("does not fire at or above it", () => {
      expect(
        needsSampleAnswer("technical", { correctness: 6, clarity: 1, depth: 6 })
      ).toBe(false);
    });

    // Clarity is not in the pair, so a fluent but wrong answer still fires.
    // This is the case that separates technical from behavioural.
    it("ignores clarity entirely", () => {
      expect(
        needsSampleAnswer("technical", { correctness: 2, clarity: 10, depth: 2 })
      ).toBe(true);
    });
  });

  describe("role_specific — correctness and depth, same as technical", () => {
    it("fires below the threshold", () => {
      expect(
        needsSampleAnswer("role_specific", { correctness: 3, clarity: 8, depth: 4 })
      ).toBe(true);
    });

    it("does not fire at or above it", () => {
      expect(
        needsSampleAnswer("role_specific", { correctness: 7, clarity: 2, depth: 8 })
      ).toBe(false);
    });

    // The pairing is the whole reason role_specific is not grouped with
    // behavioural: these questions test hands-on experience against the
    // posting, which is a correctness-and-depth question wearing a role's
    // clothes.
    it("is scored identically to technical", () => {
      const scores = { correctness: 5, clarity: 0, depth: 5 };
      expect(needsSampleAnswer("role_specific", scores)).toBe(
        needsSampleAnswer("technical", scores)
      );
    });
  });

  describe("behavioural — correctness and clarity", () => {
    it("fires below the threshold", () => {
      expect(
        needsSampleAnswer("behavioural", { correctness: 4, clarity: 5, depth: 9 })
      ).toBe(true);
    });

    it("does not fire at or above it", () => {
      expect(
        needsSampleAnswer("behavioural", { correctness: 6, clarity: 6, depth: 0 })
      ).toBe(false);
    });

    // Depth is not in the pair. "Depth" on a story about disagreeing with a
    // colleague mostly measures how long they talked, so a well-told, accurate
    // story is not weak just because it was short.
    it("ignores depth entirely", () => {
      expect(
        needsSampleAnswer("behavioural", { correctness: 9, clarity: 9, depth: 0 })
      ).toBe(false);
    });
  });

  // The boundary is exclusive: exactly at the threshold is not weak.
  it("treats the threshold itself as strong enough", () => {
    const at = EVALUATION_LIMITS.SAMPLE_ANSWER_THRESHOLD;
    expect(
      needsSampleAnswer("technical", { correctness: at, clarity: 0, depth: at })
    ).toBe(false);
  });
});

describe("the Evaluator's use of the gate", () => {
  it("keeps a sample answer on a weak technical answer", async () => {
    setModelReply(
      reply({ correctness: 3, clarity: 8, depth: 3, sampleAnswer: REWRITE })
    );

    const result = await runEvaluator(BASE);

    expect(result.sampleAnswer).toBe(REWRITE);
  });

  it("keeps one on a weak behavioural answer", async () => {
    setModelReply(
      reply({ correctness: 4, clarity: 3, depth: 9, sampleAnswer: REWRITE })
    );

    const result = await runEvaluator({ ...BASE, questionType: "behavioural" });

    expect(result.sampleAnswer).toBe(REWRITE);
  });

  it("keeps one on a weak role-specific answer", async () => {
    setModelReply(
      reply({ correctness: 2, clarity: 9, depth: 4, sampleAnswer: REWRITE })
    );

    const result = await runEvaluator({ ...BASE, questionType: "role_specific" });

    expect(result.sampleAnswer).toBe(REWRITE);
  });

  // The gate is enforced server-side rather than trusted to the prompt. A
  // rewrite attached to a strong answer reads to a candidate as "you got this
  // wrong" — which is the opposite of what the score said.
  it.each(["technical", "role_specific", "behavioural"] as const)(
    "drops one the model volunteered on a strong %s answer",
    async (questionType) => {
      setModelReply(
        reply({ correctness: 9, clarity: 9, depth: 9, sampleAnswer: REWRITE })
      );

      const result = await runEvaluator({ ...BASE, questionType });

      expect(result.sampleAnswer).toBeUndefined();
    }
  );

  // Omitted, never empty. The session summarizer reuses this where it exists
  // instead of regenerating, so "" would look like a rewrite that came back
  // blank and suppress the regeneration that should have happened.
  it("omits the key entirely rather than storing an empty string", async () => {
    setModelReply(reply({ correctness: 9, clarity: 9, depth: 9 }));

    const result = await runEvaluator(BASE);

    expect(result.sampleAnswer).toBeUndefined();
    expect("sampleAnswer" in result && result.sampleAnswer === "").toBe(false);
  });

  it("treats a whitespace-only rewrite as no rewrite", async () => {
    setModelReply(
      reply({ correctness: 2, clarity: 2, depth: 2, sampleAnswer: "   \n " })
    );

    expect((await runEvaluator(BASE)).sampleAnswer).toBeUndefined();
  });

  it("truncates a rewrite that runs past the cap", async () => {
    setModelReply(
      reply({
        correctness: 2,
        clarity: 2,
        depth: 2,
        sampleAnswer: "x".repeat(EVALUATION_LIMITS.MAX_SAMPLE_ANSWER_CHARS + 500),
      })
    );

    const result = await runEvaluator(BASE);

    expect(result.sampleAnswer?.length).toBe(
      EVALUATION_LIMITS.MAX_SAMPLE_ANSWER_CHARS
    );
  });

  // The whole point of extending the prompt rather than adding a round trip:
  // this agent already runs once per question, so a second call per weak
  // answer would be the largest cost increase in the product.
  it("stays a single model call", async () => {
    setModelReply(
      reply({ correctness: 2, clarity: 2, depth: 2, sampleAnswer: REWRITE })
    );

    await runEvaluator(BASE);

    expect(converseCallCount()).toBe(1);
  });

  it("states the conditional rule in the prompt so the common case stays cheap", async () => {
    setModelReply(reply({ correctness: 9, clarity: 9, depth: 9 }));

    await runEvaluator(BASE);

    expect(lastConverseCall()?.system).toContain("sampleAnswer is CONDITIONAL");
  });

  // A rewrite of THEIR answer, not a model answer about work they never did —
  // a candidate cannot repeat an example that is not theirs.
  it("asks for their own material back, not an invented one", async () => {
    setModelReply(reply({ correctness: 9, clarity: 9, depth: 9 }));

    await runEvaluator(BASE);

    expect(lastConverseCall()?.system).toContain("rewrite THEIR answer");
  });

  it("still returns the scores unchanged", async () => {
    setModelReply(
      reply({ correctness: 3, clarity: 8, depth: 3, sampleAnswer: REWRITE })
    );

    const result = await runEvaluator(BASE);

    expect(result.correctness).toBe(3);
    expect(result.clarity).toBe(8);
    expect(result.depth).toBe(3);
  });
});
