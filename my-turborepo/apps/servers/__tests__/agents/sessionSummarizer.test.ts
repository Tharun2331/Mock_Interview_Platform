import { beforeEach, describe, expect, it } from "bun:test";
import {
  SESSION_SUMMARY_LIMITS,
  SessionSummarySchema,
  type EvaluationView,
  type QuestionType,
} from "@repo/shared";
// The SHARED Bedrock stub — one registration of lib/bedrock for the process.
import {
  lastStructuredCall,
  resetStructuredStub,
  setStructuredFailure,
  setStructuredReplies,
  setStructuredTextReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";

const { runSessionSummarizer, weakestAnswers, categoryBreakdown } =
  await import("../../agents/sessionSummarizer");

let counter = 0;

function answer(overrides: Partial<EvaluationView> = {}): EvaluationView {
  counter += 1;
  return {
    questionId: `01J0000000000000000000${String(counter).padStart(2, "0")}`,
    questionText: "How do you decide between a queue and a direct call?",
    questionType: "technical",
    transcript: "Queues are good when you want things to be asynchronous.",
    interrupted: false,
    durationMs: 40_000,
    correctness: 8,
    clarity: 8,
    depth: 8,
    rationale: "Solid.",
    evaluatedAt: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

/** A weak answer that already carries the Evaluator's rewrite. */
function weakWithRewrite(overrides: Partial<EvaluationView> = {}): EvaluationView {
  return answer({
    correctness: 2,
    clarity: 2,
    depth: 2,
    sampleAnswer: "At EY I put the tax export behind SQS because it timed out.",
    ...overrides,
  });
}

const PARAGRAPH = {
  summaryText:
    "On technical questions you named the right tradeoffs but stopped short of the systems you actually built.",
  rewrites: [],
};

beforeEach(() => {
  counter = 0;
  resetStructuredStub();
  setStructuredReplies([PARAGRAPH]);
});

describe("a session with no weak answers", () => {
  it("flags nothing", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer(), answer(), answer()],
    });

    expect(summary?.flaggedExamples).toEqual([]);
  });

  // The summary is still worth writing. "Everything went well" is a pattern
  // across answers, which is exactly what this agent exists to see.
  it("still writes the paragraph", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer(), answer()],
    });

    expect(summary?.summaryText).toBe(PARAGRAPH.summaryText);
  });

  // Padding the list to a fixed length would show a candidate a "weakest
  // answer" that was actually fine, which teaches them to distrust the report.
  it("does not pad the list to reach the cap", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer({ correctness: 10, clarity: 10, depth: 10 })],
    });

    expect(summary?.flaggedExamples).toHaveLength(0);
  });
});

describe("a session with no scored answers at all", () => {
  it("returns null rather than an empty summary", async () => {
    expect(
      await runSessionSummarizer({ role: "Backend Engineer", evaluations: [] })
    ).toBeNull();
  });

  it("does not call the model", async () => {
    await runSessionSummarizer({ role: "Backend Engineer", evaluations: [] });

    expect(structuredCallCount()).toBe(0);
  });
});

describe("a session mixing all three categories", () => {
  function mixed(): EvaluationView[] {
    return [
      answer({ questionType: "technical", correctness: 3, depth: 3 }),
      answer({ questionType: "role_specific", correctness: 4, depth: 4 }),
      answer({ questionType: "behavioural", correctness: 3, clarity: 3, depth: 9 }),
      answer({ questionType: "technical", correctness: 9, depth: 9 }),
    ];
  }

  it("reports each category that was actually asked", () => {
    const breakdown = categoryBreakdown(mixed());

    expect(breakdown.map((entry) => entry.category)).toEqual([
      "technical",
      "role_specific",
      "behavioural",
    ]);
  });

  // A category with no questions has no weakness — reporting it as zero would
  // invent a failure in something the interview never covered.
  it("omits a category that was never asked", () => {
    const breakdown = categoryBreakdown([answer({ questionType: "technical" })]);

    expect(breakdown).toHaveLength(1);
    expect(breakdown[0]?.category).toBe("technical");
  });

  it("puts the per-category scores in the prompt", async () => {
    await runSessionSummarizer({ role: "Backend Engineer", evaluations: mixed() });

    const call = lastStructuredCall() as { prompt: string };
    expect(call.prompt).toContain("technical:");
    expect(call.prompt).toContain("role_specific:");
    expect(call.prompt).toContain("behavioural:");
  });

  // Behavioural weakness is correctness-and-clarity; technical is
  // correctness-and-depth. The same pairing the Evaluator gates on, so "weak"
  // means one thing across the pipeline.
  it("judges each category by its own dimensions", () => {
    const weak = weakestAnswers([
      // Strong behaviourally despite depth 0 — depth is not in its pair.
      answer({ questionType: "behavioural", correctness: 9, clarity: 9, depth: 0 }),
      // Weak technically despite clarity 10 — clarity is not in its pair.
      answer({ questionType: "technical", correctness: 2, clarity: 10, depth: 2 }),
    ]);

    expect(weak).toHaveLength(1);
    expect(weak[0]?.questionType).toBe("technical");
  });

  it("caps the flagged list", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [
        weakWithRewrite(),
        weakWithRewrite(),
        weakWithRewrite(),
        weakWithRewrite(),
        weakWithRewrite(),
      ],
    });

    expect(summary?.flaggedExamples.length).toBeLessThanOrEqual(
      SESSION_SUMMARY_LIMITS.MAX_FLAGGED
    );
  });

  it("orders the flagged list worst first", () => {
    const weak = weakestAnswers([
      answer({ correctness: 5, depth: 5, questionText: "middling" }),
      answer({ correctness: 0, depth: 0, questionText: "worst" }),
      answer({ correctness: 3, depth: 3, questionText: "bad" }),
    ]);

    expect(weak.map((view) => view.questionText)).toEqual([
      "worst",
      "bad",
      "middling",
    ]);
  });
});

// The reuse rule, and the reason this agent is cheaper than it looks.
describe("reusing the Evaluator's rewrites", () => {
  it("uses the existing sampleAnswer rather than regenerating it", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite()],
    });

    expect(summary?.flaggedExamples[0]?.improvedAnswer).toBe(
      "At EY I put the tax export behind SQS because it timed out."
    );
  });

  // The assertion that proves it did not pay twice: an answer that already has
  // a rewrite is never listed as needing one.
  it("does not ask the model to rewrite an answer that already has one", async () => {
    await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite(), weakWithRewrite()],
    });

    const call = lastStructuredCall() as { prompt: string };
    expect(call.prompt).not.toContain("[NEEDS A REWRITE]");
  });

  // The gap case: a row written before sample answers existed, or one whose
  // rewrite came back unusable.
  it("asks for a rewrite only where one is missing", async () => {
    setStructuredReplies([
      {
        summaryText: PARAGRAPH.summaryText,
        rewrites: [
          { questionId: "01J000000000000000000001", improvedAnswer: "Filled the gap." },
        ],
      },
    ]);

    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer({ correctness: 1, clarity: 1, depth: 1 })],
    });

    const call = lastStructuredCall() as { prompt: string };
    expect(call.prompt).toContain("[NEEDS A REWRITE]");
    expect(summary?.flaggedExamples[0]?.improvedAnswer).toBe("Filled the gap.");
  });

  // Two different "improved answers" for one question, depending on which
  // screen you read, would be worse than none.
  it("prefers the stored rewrite over one the model volunteered", async () => {
    setStructuredReplies([
      {
        summaryText: PARAGRAPH.summaryText,
        rewrites: [
          { questionId: "01J000000000000000000001", improvedAnswer: "A second opinion." },
        ],
      },
    ]);

    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite()],
    });

    expect(summary?.flaggedExamples[0]?.improvedAnswer).not.toBe("A second opinion.");
  });

  // Same guard the Coach applies to topics: anything the input did not name is
  // discarded rather than trusted.
  it("discards a rewrite for a question that was not flagged", async () => {
    setStructuredReplies([
      {
        summaryText: PARAGRAPH.summaryText,
        rewrites: [
          { questionId: "a-question-that-does-not-exist", improvedAnswer: "Invented." },
        ],
      },
    ]);

    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite()],
    });

    expect(JSON.stringify(summary)).not.toContain("Invented.");
  });

  // An example with only an original answer is the transcript again.
  it("drops a weak answer that has no rewrite from either source", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer({ correctness: 1, clarity: 1, depth: 1 })],
    });

    expect(summary?.flaggedExamples).toEqual([]);
    expect(summary?.summaryText.length).toBeGreaterThan(0);
  });
});

describe("what it produces", () => {
  it("satisfies the stored schema", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite(), answer()],
    });

    expect(SessionSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("carries the category on every flagged example", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite({ questionType: "behavioural", clarity: 1 })],
    });

    expect(summary?.flaggedExamples[0]?.category).toBe("behavioural");
  });

  it("keeps the candidate's own words as the original", async () => {
    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite({ transcript: "I do not know." })],
    });

    expect(summary?.flaggedExamples[0]?.originalAnswer).toBe("I do not know.");
  });

  it("truncates a paragraph that runs past the cap", async () => {
    setStructuredReplies([
      {
        summaryText: "x".repeat(SESSION_SUMMARY_LIMITS.MAX_SUMMARY_CHARS + 400),
        rewrites: [],
      },
    ]);

    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer()],
    });

    expect(summary?.summaryText.length).toBe(
      SESSION_SUMMARY_LIMITS.MAX_SUMMARY_CHARS
    );
  });

  it("parses a reply the model wrote as prose", async () => {
    setStructuredTextReplies(["```json\n" + JSON.stringify(PARAGRAPH) + "\n```"]);

    const summary = await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer()],
    });

    expect(summary?.summaryText).toBe(PARAGRAPH.summaryText);
  });
});

// A session without a summary is a session the Coach reads a little less
// about. A session that fails to close out is a candidate with no feedback.
describe("a failed generation", () => {
  it("returns null rather than throwing", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    expect(
      await runSessionSummarizer({
        role: "Backend Engineer",
        evaluations: [answer()],
      })
    ).toBeNull();
  });

  it("returns null when the model produced no paragraph", async () => {
    setStructuredReplies([{ summaryText: "   ", rewrites: [] }]);

    expect(
      await runSessionSummarizer({
        role: "Backend Engineer",
        evaluations: [answer()],
      })
    ).toBeNull();
  });

  // One attempt. The fallback — no summary — is already an acceptable outcome,
  // so a retry buys a paragraph at the cost of a second generation per session.
  it("does not retry", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer()],
    });

    expect(structuredCallCount()).toBe(1);
  });
});

describe("the prompt it builds", () => {
  it("tells the model never to state a score", async () => {
    await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [answer()],
    });

    const call = lastStructuredCall() as { system: string };
    expect(call.system).toContain("Never state a score");
  });

  // The answer is the one field a candidate fully controls, so it goes last in
  // each block — anything embedded in it reads as the final word otherwise.
  it("puts the candidate's words after the question", async () => {
    await runSessionSummarizer({
      role: "Backend Engineer",
      evaluations: [weakWithRewrite({ transcript: "MY ANSWER TEXT" })],
    });

    const call = lastStructuredCall() as { prompt: string };
    expect(call.prompt.indexOf("MY ANSWER TEXT")).toBeGreaterThan(
      call.prompt.indexOf("question:")
    );
  });

  it.each(["technical", "role_specific", "behavioural"] as const)(
    "labels a flagged %s example with its category",
    async (questionType: QuestionType) => {
      await runSessionSummarizer({
        role: "Backend Engineer",
        evaluations: [
          weakWithRewrite({ questionType, correctness: 1, clarity: 1, depth: 1 }),
        ],
      });

      const call = lastStructuredCall() as { prompt: string };
      expect(call.prompt).toContain(`category: ${questionType}`);
    }
  );
});
