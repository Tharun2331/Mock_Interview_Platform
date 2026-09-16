import { beforeEach, describe, expect, it } from "bun:test";
import { GAP_LIMITS, GapAnalysisSchema } from "@repo/shared";
// The SHARED Bedrock stub, not a local mock.module. lib/bedrock is one module
// and mock.module replaces all of it, so a second registration here would
// delete converseText for every test loaded afterwards.
import {
  resetStructuredStub,
  setStructuredReplies,
  setStructuredTextReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";

const { runGapAgent } = await import("../../agents/gap");
const { BedrockError } = await import("../../lib/errors");

const INPUT = {
  sessionId: "01J000000000000000000000",
  resumeText: "Three years of React and Node at EY.",
  githubSummary: "- order-service: Kafka consumers in TypeScript",
  jobDescription: "React, Kafka, Terraform, Kubernetes.",
};

const REQUIREMENTS = [
  { requirement: "React", bucket: "strong", evidence: "three years at EY" },
  { requirement: "Kafka", bucket: "strong", evidence: "order-service consumers" },
  { requirement: "Terraform", bucket: "weak", evidence: "cloud work, no Terraform named" },
  { requirement: "Kubernetes", bucket: "none", evidence: "not mentioned anywhere" },
];

beforeEach(() => {
  resetStructuredStub();
  setStructuredReplies([{ requirements: REQUIREMENTS }]);
});

describe("bucketing", () => {
  it("returns one bucket for every requirement", async () => {
    const analysis = await runGapAgent(INPUT);

    expect(analysis.requirements).toHaveLength(4);
    for (const item of analysis.requirements) {
      expect(["strong", "weak", "none"]).toContain(item.bucket);
    }
  });

  // An enum rather than three booleans, so "strong and none" is
  // unrepresentable rather than merely unlikely.
  it("gives each requirement exactly one bucket and leaves none unsorted", async () => {
    const analysis = await runGapAgent(INPUT);

    const names = analysis.requirements.map((item) => item.requirement);
    expect(new Set(names).size).toBe(names.length);

    const bucketed =
      analysis.requirements.filter((i) => i.bucket === "strong").length +
      analysis.requirements.filter((i) => i.bucket === "weak").length +
      analysis.requirements.filter((i) => i.bucket === "none").length;
    expect(bucketed).toBe(analysis.requirements.length);
  });

  it("carries an evidence note on every requirement, including 'none'", async () => {
    const analysis = await runGapAgent(INPUT);

    for (const item of analysis.requirements) {
      expect(item.evidence.length).toBeGreaterThan(0);
    }
    // "no evidence found" is the most useful note of the three — it is what the
    // interview is going to probe.
    const missing = analysis.requirements.find((i) => i.bucket === "none");
    expect(missing?.evidence).toBe("not mentioned anywhere");
  });

  // sessionId and createdAt are the server's to set. A model that could supply
  // its own sessionId could write an analysis onto a different interview.
  it("stamps the session and time itself rather than trusting the model", async () => {
    setStructuredReplies([
      {
        requirements: REQUIREMENTS,
        sessionId: "some-other-session",
        createdAt: "1999-01-01T00:00:00.000Z",
      },
    ]);

    const analysis = await runGapAgent(INPUT);

    expect(analysis.sessionId).toBe(INPUT.sessionId);
    expect(analysis.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(GapAnalysisSchema.safeParse(analysis).success).toBe(true);
  });

  it("produces an item that satisfies the stored schema", async () => {
    const analysis = await runGapAgent(INPUT);

    expect(GapAnalysisSchema.safeParse(analysis).success).toBe(true);
  });
});

// Tool use is the primary path, but support varies across the three models in
// the chain, so a model that answers in prose must still produce a usable
// object rather than a failed request.
describe("the text fallback", () => {
  it("parses a fenced JSON reply", async () => {
    setStructuredTextReplies(["```json\n" + JSON.stringify({ requirements: REQUIREMENTS }) + "\n```"]);

    expect((await runGapAgent(INPUT)).requirements).toHaveLength(4);
  });

  it("parses a reply wrapped in commentary", async () => {
    setStructuredTextReplies([`Here is the analysis:\n${JSON.stringify({ requirements: REQUIREMENTS })}\nHope that helps.`]);

    expect((await runGapAgent(INPUT)).requirements).toHaveLength(4);
  });
});

// Retries once on a validation failure, and only on that.
describe("handling an unusable generation", () => {
  it("retries once and succeeds on the second attempt", async () => {
    setStructuredReplies([{ nonsense: true }, { requirements: REQUIREMENTS }]);

    const analysis = await runGapAgent(INPUT);

    expect(analysis.requirements).toHaveLength(4);
    expect(structuredCallCount()).toBe(2);
  });

  it("throws a typed error rather than crashing on non-JSON output", async () => {
    setStructuredTextReplies([
      "I could not read that job description.",
      "Still prose.",
    ]);

    await expect(runGapAgent(INPUT)).rejects.toThrow(BedrockError);
    expect(structuredCallCount()).toBe(2);
  });

  it("does not retry more than once", async () => {
    setStructuredReplies([{ nonsense: true }, { nonsense: true }]);

    await expect(runGapAgent(INPUT)).rejects.toThrow(BedrockError);
    expect(structuredCallCount()).toBe(2);
  });

  // Zod is the second line of defence behind the tool schema, which the model
  // can still ignore.
  it("rejects a bucket outside the enum", async () => {
    const invalid = [
      { requirement: "React", bucket: "excellent", evidence: "three years" },
    ];
    setStructuredReplies([{ requirements: invalid }, { requirements: invalid }]);

    await expect(runGapAgent(INPUT)).rejects.toThrow(/bucket/);
  });

  it("rejects a requirement with no evidence note", async () => {
    const invalid = [{ requirement: "React", bucket: "strong", evidence: "" }];
    setStructuredReplies([{ requirements: invalid }, { requirements: invalid }]);

    await expect(runGapAgent(INPUT)).rejects.toThrow(BedrockError);
  });

  // Capped to control token spend: the evidence note is generated text, so the
  // output grows linearly with the count.
  it("rejects more requirements than the cap allows", async () => {
    const tooMany = Array.from(
      { length: GAP_LIMITS.MAX_REQUIREMENTS + 1 },
      (_unused, index) => ({
        requirement: `Requirement ${index}`,
        bucket: "none" as const,
        evidence: "not mentioned",
      })
    );
    setStructuredReplies([{ requirements: tooMany }, { requirements: tooMany }]);

    await expect(runGapAgent(INPUT)).rejects.toThrow(BedrockError);
  });
});

describe("the prompt it builds", () => {
  it("never makes a live model call in tests", async () => {
    await runGapAgent(INPUT);

    // The only Bedrock surface the agent touches is the mocked one.
    expect(structuredCallCount()).toBeGreaterThan(0);
  });

  it("truncates an over-long job description rather than failing", async () => {
    await runGapAgent({
      ...INPUT,
      jobDescription: "x".repeat(GAP_LIMITS.MAX_JOB_DESCRIPTION_CHARS + 5_000),
    });

    expect(structuredCallCount()).toBeGreaterThan(0);
  });
});
