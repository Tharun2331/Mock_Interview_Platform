import { describe, expect, it } from "bun:test";
import {
  PLAN_LIMITS,
  PlannerInputSchema,
  PlanRequestSchema,
  PlanResponseSchema,
} from "../../src/schemas/plan";

// PlanResponseSchema is validated directly against model output, so these tests
// double as a specification of what the Planner is allowed to emit. Every
// rejection here is a generation the route turns into a BedrockError.

// Overrides are deliberately untyped rather than `Partial<PlanResponse>`: half
// these tests exist to feed the schema values the type system would reject,
// which is exactly what an unvalidated model generation can contain.
function validPlan(overrides: Record<string, unknown> = {}): unknown {
  return {
    focusAreas: [
      {
        area: "Event-driven order pipeline design",
        evidence: "order-service implements Kafka consumers",
        source: "github",
      },
      {
        area: "Monolith-to-microservices migration",
        evidence: "resume states they led the migration",
        source: "resume",
      },
    ],
    questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
    startingDifficulty: "mid",
    targetMinutes: 30,
    reasoning: "Repos show hands-on distributed-systems work at single-service scope.",
    ...overrides,
  };
}

describe("PlanResponseSchema", () => {
  it("accepts a well-formed plan", () => {
    expect(PlanResponseSchema.safeParse(validPlan()).success).toBe(true);
  });

  // The .refine() exists precisely because every individual field bound passes
  // here. Without it this plan describes an interview with no questions.
  it("rejects an all-zero question mix that satisfies every field bound", () => {
    const parsed = PlanResponseSchema.safeParse(
      validPlan({ questionMix: { behavioural: 0, technical: 0, roleSpecific: 0 } })
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path[0] === "questionMix")).toBe(
        true
      );
    }
  });

  it("enforces the question total at both ends", () => {
    const justUnder = PLAN_LIMITS.MIN_QUESTIONS - 1;
    expect(
      PlanResponseSchema.safeParse(
        validPlan({
          questionMix: { behavioural: justUnder, technical: 0, roleSpecific: 0 },
        })
      ).success
    ).toBe(false);

    expect(
      PlanResponseSchema.safeParse(
        validPlan({
          questionMix: {
            behavioural: PLAN_LIMITS.MIN_QUESTIONS,
            technical: 0,
            roleSpecific: 0,
          },
        })
      ).success
    ).toBe(true);

    expect(
      PlanResponseSchema.safeParse(
        validPlan({
          questionMix: {
            behavioural: PLAN_LIMITS.MAX_QUESTIONS,
            technical: 1,
            roleSpecific: 0,
          },
        })
      ).success
    ).toBe(false);
  });

  it("enforces the focus-area count at both ends", () => {
    const area = {
      area: "a",
      evidence: "e",
      source: "github" as const,
    };

    expect(
      PlanResponseSchema.safeParse(
        validPlan({ focusAreas: Array(PLAN_LIMITS.MIN_FOCUS_AREAS - 1).fill(area) })
      ).success
    ).toBe(false);

    expect(
      PlanResponseSchema.safeParse(
        validPlan({ focusAreas: Array(PLAN_LIMITS.MAX_FOCUS_AREAS).fill(area) })
      ).success
    ).toBe(true);

    expect(
      PlanResponseSchema.safeParse(
        validPlan({ focusAreas: Array(PLAN_LIMITS.MAX_FOCUS_AREAS + 1).fill(area) })
      ).success
    ).toBe(false);
  });

  // Evidence is what stops the model restating the job description as a plan,
  // so an empty string has to fail rather than pass as "present".
  it("rejects a focus area with empty evidence", () => {
    expect(
      PlanResponseSchema.safeParse(
        validPlan({
          focusAreas: [
            { area: "Kafka", evidence: "", source: "github" },
            { area: "Postgres", evidence: "order-service uses it", source: "github" },
          ],
        })
      ).success
    ).toBe(false);
  });

  it("rejects a focus-area source outside the enum", () => {
    expect(
      PlanResponseSchema.safeParse(
        validPlan({
          focusAreas: [
            { area: "Kafka", evidence: "order-service", source: "linkedin" },
            { area: "Postgres", evidence: "order-service", source: "github" },
          ],
        })
      ).success
    ).toBe(false);
  });

  it("enforces the spoken-interview minute budget", () => {
    expect(
      PlanResponseSchema.safeParse(
        validPlan({ targetMinutes: PLAN_LIMITS.MIN_TARGET_MINUTES - 1 })
      ).success
    ).toBe(false);
    expect(
      PlanResponseSchema.safeParse(
        validPlan({ targetMinutes: PLAN_LIMITS.MAX_TARGET_MINUTES + 1 })
      ).success
    ).toBe(false);
    expect(
      PlanResponseSchema.safeParse(validPlan({ targetMinutes: 30.5 })).success
    ).toBe(false);
  });

  it("rejects a difficulty outside the enum", () => {
    expect(
      PlanResponseSchema.safeParse(validPlan({ startingDifficulty: "principal" }))
        .success
    ).toBe(false);
  });
});

// The wire contract deliberately no longer accepts repos or resumeText — that
// was how a caller could plan against someone else's material. Zod strips
// unknown keys by default, so the assertion is that they do not survive.
describe("PlanRequestSchema", () => {
  it("accepts a session reference and a target role", () => {
    const parsed = PlanRequestSchema.safeParse({
      sessionId: "01J000000000000000000000",
      targetRole: "Backend Engineer",
    });

    expect(parsed.success).toBe(true);
  });

  it("strips candidate material a client tries to smuggle in", () => {
    const parsed = PlanRequestSchema.safeParse({
      sessionId: "01J000000000000000000000",
      targetRole: "Backend Engineer",
      resumeText: "someone else's resume",
      repos: [{ description: null, name: "x", fullName: "y/x", starCount: 1 }],
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        sessionId: "01J000000000000000000000",
        targetRole: "Backend Engineer",
      });
    }
  });

  it("rejects an empty session id or role", () => {
    expect(
      PlanRequestSchema.safeParse({ sessionId: "", targetRole: "Backend" }).success
    ).toBe(false);
    expect(
      PlanRequestSchema.safeParse({ sessionId: "abc", targetRole: "" }).success
    ).toBe(false);
  });

  it("caps the target role length", () => {
    expect(
      PlanRequestSchema.safeParse({
        sessionId: "abc",
        targetRole: "a".repeat(201),
      }).success
    ).toBe(false);
  });
});

describe("PlannerInputSchema", () => {
  // A plan built from GitHub alone is worse but valid.
  it("defaults repos to an empty array and allows an absent resume", () => {
    const parsed = PlannerInputSchema.safeParse({ targetRole: "Backend Engineer" });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.repos).toEqual([]);
      expect(parsed.data.resumeText).toBeUndefined();
    }
  });

  it("rejects a resume longer than the storage ceiling", () => {
    expect(
      PlannerInputSchema.safeParse({
        targetRole: "Backend Engineer",
        resumeText: "a".repeat(PLAN_LIMITS.MAX_RESUME_CHARS + 1),
      }).success
    ).toBe(false);
  });

  it("rejects more repos than the prompt budget allows", () => {
    const repo = { description: null, name: "x", fullName: "y/x", starCount: 0 };
    expect(
      PlannerInputSchema.safeParse({
        targetRole: "Backend Engineer",
        repos: Array(PLAN_LIMITS.MAX_REPOS + 1).fill(repo),
      }).success
    ).toBe(false);
  });
});
