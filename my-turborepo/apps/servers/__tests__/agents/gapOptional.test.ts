import { describe, expect, it } from "bun:test";
import {
  GapAnalysisSchema,
  gapQuestionTargets,
  type GapAnalysis,
  type PlanResponse,
} from "@repo/shared";
import { buildInterviewSystemPrompt } from "../../agents/mockInterview";

// The job description is optional throughout, and its absence is the default
// path rather than an error path: no posting means no Gap agent, no stored
// analysis, and an interview that runs on resume and GitHub alone — which is
// exactly what this product did before any of it existed.

const PLAN: PlanResponse = {
  focusAreas: [
    { area: "Kafka", evidence: "order-service consumers", source: "github" },
    { area: "Postgres", evidence: "order-service persistence", source: "github" },
  ],
  questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
  startingDifficulty: "mid",
  targetMinutes: 30,
  reasoning: "single-service distributed work",
};

const ANALYSIS: GapAnalysis = {
  type: "session_gap",
  sessionId: "01J000000000000000000000",
  requirements: [
    { requirement: "Kubernetes", bucket: "none", evidence: "not mentioned" },
    { requirement: "Terraform", bucket: "weak", evidence: "cloud work, no IaC named" },
    { requirement: "Kafka", bucket: "strong", evidence: "order-service consumers" },
  ],
  createdAt: "2026-09-12T10:00:00.000Z",
};

describe("an interview with no gap analysis", () => {
  // The requirement that matters most: a null analysis must not throw.
  it("builds a prompt without one", () => {
    expect(() => buildInterviewSystemPrompt(PLAN)).not.toThrow();
    expect(() =>
      buildInterviewSystemPrompt(PLAN, { gapAnalysis: null })
    ).not.toThrow();
  });

  it("omits the job-description section entirely", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { gapAnalysis: null });

    expect(prompt).not.toContain("WHAT THIS ROLE ASKS FOR");
  });

  // Falls back to the behaviour it had before the Gap agent existed: questions
  // built from the session brief alone.
  it("still carries the session brief and its focus areas", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { gapAnalysis: null });

    expect(prompt).toContain("SESSION BRIEF");
    expect(prompt).toContain("Kafka");
    expect(prompt).toContain("Postgres");
  });

  it("is the default when the option is simply not passed", () => {
    expect(buildInterviewSystemPrompt(PLAN)).not.toContain(
      "WHAT THIS ROLE ASKS FOR"
    );
  });
});

describe("an interview with a gap analysis", () => {
  it("renders the budget section", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { gapAnalysis: ANALYSIS });

    expect(prompt).toContain("WHAT THIS ROLE ASKS FOR");
    expect(prompt).toContain("Kubernetes");
    expect(prompt).toContain("Terraform");
  });

  // Roughly 60% of questions target what has no evidence, 40% confirm what
  // does. Expressed as a rule because the interviewer has no counter.
  it("states the split as a proportion rather than a count", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { gapAnalysis: ANALYSIS });

    expect(prompt).toContain("three questions in five");
    expect(prompt).toContain("two questions in five");
  });

  // Telling a candidate they were bucketed "none" mid-answer would be the
  // interview grading them out loud.
  it("tells the interviewer not to read the buckets aloud", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { gapAnalysis: ANALYSIS });

    expect(prompt).toContain("Do not read the list aloud");
  });

  // An analysis that found no requirements is a posting the model could not
  // read. Inventing emphasis from it is worse than falling back to the brief.
  it("omits the section for an analysis with no requirements", () => {
    const empty: GapAnalysis = { ...ANALYSIS, requirements: [] };

    expect(buildInterviewSystemPrompt(PLAN, { gapAnalysis: empty })).not.toContain(
      "WHAT THIS ROLE ASKS FOR"
    );
  });
});

describe("gapQuestionTargets", () => {
  it("probes what has no or weak evidence, confirms what is strong", () => {
    const { probe, confirm } = gapQuestionTargets(ANALYSIS);

    expect(probe.map((item) => item.requirement)).toEqual([
      // "none" leads: a requirement with no evidence is the most valuable
      // thing to ask about.
      "Kubernetes",
      "Terraform",
    ]);
    expect(confirm.map((item) => item.requirement)).toEqual(["Kafka"]);
  });

  it("puts every requirement in exactly one of the two lists", () => {
    const { probe, confirm } = gapQuestionTargets(ANALYSIS);

    expect(probe.length + confirm.length).toBe(ANALYSIS.requirements.length);
    const names = [...probe, ...confirm].map((item) => item.requirement);
    expect(new Set(names).size).toBe(names.length);
  });

  it("handles an analysis that is entirely one bucket", () => {
    const allStrong: GapAnalysis = {
      ...ANALYSIS,
      requirements: ANALYSIS.requirements.map((item) => ({
        ...item,
        bucket: "strong" as const,
      })),
    };

    const { probe, confirm } = gapQuestionTargets(allStrong);
    expect(probe).toHaveLength(0);
    expect(confirm).toHaveLength(3);
  });
});

// Stored so an interview can be resumed, or its stream renewed, without paying
// for the analysis again.
describe("the stored shape", () => {
  it("round-trips through its schema", () => {
    const parsed = GapAnalysisSchema.safeParse(ANALYSIS);

    expect(parsed.success).toBe(true);
  });

  it("defaults `type` for a row written before the attribute existed", () => {
    const { type: _dropped, ...withoutType } = ANALYSIS;
    const parsed = GapAnalysisSchema.safeParse(withoutType);

    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.type).toBe("session_gap");
  });
});
