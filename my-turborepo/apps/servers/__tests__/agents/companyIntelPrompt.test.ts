import { describe, expect, it } from "bun:test";
import type { CompanyIntel, PlanResponse } from "@repo/shared";
import { buildInterviewSystemPrompt } from "../../agents/mockInterview";

const PLAN: PlanResponse = {
  focusAreas: [
    { area: "Kafka", evidence: "order-service consumers", source: "github" },
  ],
  questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
  startingDifficulty: "mid",
  targetMinutes: 30,
  reasoning: "single-service distributed work",
};

function intel(overrides: Partial<CompanyIntel> = {}): CompanyIntel {
  return {
    type: "session_intel",
    sessionId: "01J000000000000000000000",
    company: "Acme Systems",
    style: "practical",
    focus: "infrastructure",
    seniority: "senior",
    sourceCount: 4,
    createdAt: "2026-09-16T10:00:00.000Z",
    ...overrides,
  };
}

const UNKNOWN = intel({
  style: "unknown",
  focus: "unknown",
  seniority: "unknown",
  sourceCount: 0,
});

describe("an interview with no company intel", () => {
  // The requirement that matters most, and the same one the gap analysis has:
  // a null must not throw. Most sessions will never name a company.
  it("builds a prompt without one", () => {
    expect(() => buildInterviewSystemPrompt(PLAN)).not.toThrow();
    expect(() =>
      buildInterviewSystemPrompt(PLAN, { companyIntel: null }),
    ).not.toThrow();
  });

  it("omits the section entirely", () => {
    expect(
      buildInterviewSystemPrompt(PLAN, { companyIntel: null }),
    ).not.toContain("TENDS TO INTERVIEW");
  });

  it("still carries the session brief", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { companyIntel: null });

    expect(prompt).toContain("SESSION BRIEF");
    expect(prompt).toContain("Kafka");
  });
});

// An all-unknown result is a successful run of the agent, not a failure — but
// it is worth nothing to a prompt. Rendering "we could not tell you anything"
// spends tokens telling the interviewer to ignore a section.
describe("an all-unknown reading", () => {
  it("renders nothing at all", () => {
    expect(
      buildInterviewSystemPrompt(PLAN, { companyIntel: UNKNOWN }),
    ).not.toContain("TENDS TO INTERVIEW");
  });

  it("does not throw", () => {
    expect(() =>
      buildInterviewSystemPrompt(PLAN, { companyIntel: UNKNOWN }),
    ).not.toThrow();
  });

  // The notes are the highest-quality input this agent ever gets — a person
  // who spoke to a recruiter. They survive an otherwise empty reading.
  it("still renders when the candidate wrote notes", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, {
      companyIntel: intel({ ...UNKNOWN, notes: "One long pairing session." }),
    });

    expect(prompt).toContain("TENDS TO INTERVIEW");
    expect(prompt).toContain("One long pairing session.");
  });
});

describe("what a reading puts in the prompt", () => {
  it("names the company", () => {
    expect(
      buildInterviewSystemPrompt(PLAN, { companyIntel: intel() }),
    ).toContain("ACME SYSTEMS");
  });

  it.each([
    ["practical", "Lean practical"],
    ["theoretical", "Lean theoretical"],
    ["mixed", "Mix practical and theoretical"],
  ] as const)("renders style %s", (style, expected) => {
    expect(
      buildInterviewSystemPrompt(PLAN, { companyIntel: intel({ style }) }),
    ).toContain(expected);
  });

  it.each([
    ["product", "Weight toward product work"],
    ["infrastructure", "Weight toward systems work"],
    ["mixed", "comparable weight"],
  ] as const)("renders focus %s", (focus, expected) => {
    expect(
      buildInterviewSystemPrompt(PLAN, { companyIntel: intel({ focus }) }),
    ).toContain(expected);
  });

  // An unknown field is silently skipped rather than rendered as "unknown". A
  // company the search could not read should leave the interview exactly as it
  // found it, not add a line about its own ignorance.
  it("skips an unknown field rather than naming it", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, {
      companyIntel: intel({ focus: "unknown" }),
    });

    expect(prompt).toContain("Lean practical");
    expect(prompt).not.toContain("Weight toward");
    expect(prompt).not.toContain("unknown");
  });

  // Phrased as the bar to hold, never as a level to assign: the plan's own
  // startingDifficulty is what is being tested live, and this must not
  // override what the interviewer actually hears.
  it("states seniority as a standard and still defers to what is heard", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, {
      companyIntel: intel({ seniority: "senior" }),
    });

    expect(prompt).toContain("senior bar");
    expect(prompt).toContain(
      "keep calibrating difficulty to what you actually hear",
    );
  });
});

describe("the user override", () => {
  // The spec's rule, and the only place two sources can disagree: the
  // candidate spoke to someone, the enums came off a public page.
  it("states that the candidate's notes outrank the rest", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, {
      companyIntel: intel({ notes: "Actually it is all system design." }),
    });

    expect(prompt).toContain("Where it disagrees with anything");
    expect(prompt).toContain("this is what is true");
  });

  it("puts the notes above the classified fields, not after them", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, {
      companyIntel: intel({ notes: "Recruiter said two rounds." }),
    });

    expect(prompt.indexOf("Recruiter said two rounds.")).toBeLessThan(
      prompt.indexOf("Lean practical"),
    );
  });
});

// The v1 scope limit, and the tests most worth keeping. A company famous for
// algorithm puzzles gets "lean theoretical" — it does not get a LeetCode round,
// because there is no execution sandbox to run one in.
describe("the scope limit", () => {
  it("says the reading does not add a round", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { companyIntel: intel() });

    expect(prompt).toContain("It does not add a round");
  });

  it.each(["whiteboard", "coding exercise"])(
    "names %s as something it does not add",
    (surface) => {
      expect(
        buildInterviewSystemPrompt(PLAN, { companyIntel: intel() }),
      ).toContain(surface);
    },
  );

  // The ordering rule. The gap budget decides WHAT gets asked; this decides
  // only HOW. Reversed, a company's reputation could pull the interview off
  // the requirements the posting actually listed.
  it("never outranks the job description's requirements", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, { companyIntel: intel() });

    expect(prompt).toContain("never outranks the requirements");
  });

  it("tells the interviewer not to mention the company's process aloud", () => {
    expect(
      buildInterviewSystemPrompt(PLAN, { companyIntel: intel() }),
    ).toContain("Do not mention the company's process aloud");
  });
});

describe("intel and a gap analysis together", () => {
  // Both sections present, and the gap budget first — the order is the
  // precedence, and a refactor that reorders them changes what the interview
  // optimises for.
  it("renders the gap budget before the company reading", () => {
    const prompt = buildInterviewSystemPrompt(PLAN, {
      companyIntel: intel(),
      gapAnalysis: {
        type: "session_gap",
        sessionId: "01J000000000000000000000",
        requirements: [
          {
            requirement: "Kubernetes",
            bucket: "none",
            evidence: "not mentioned",
          },
        ],
        createdAt: "2026-09-16T10:00:00.000Z",
      },
    });

    expect(prompt.indexOf("WHAT THIS ROLE ASKS FOR")).toBeLessThan(
      prompt.indexOf("TENDS TO INTERVIEW"),
    );
  });
});
