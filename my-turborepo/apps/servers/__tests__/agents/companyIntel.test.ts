import { beforeEach, describe, expect, it } from "bun:test";
import { CompanyIntelSchema, intelIsEmpty } from "@repo/shared";
// The SHARED stub. lib/bedrock is registered exactly once for the whole
// process — see the header of bedrockStub.ts.
import {
  resetStructuredStub,
  setStructuredFailure,
  setStructuredReplies,
  setStructuredTextReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";

const { runCompanyIntelAgent } = await import("../../agents/companyIntel");

const INPUT = {
  company: "Acme Systems",
  sessionId: "01J000000000000000000000",
};

const CLASSIFIED = { style: "practical", focus: "infrastructure", seniority: "senior" };

beforeEach(() => {
  resetStructuredStub();
  setStructuredReplies([CLASSIFIED]);
});

// Every one of these is a path the spec requires to end in a working interview.
describe("degradation is the default path", () => {
  it("returns all-unknown when the candidate wrote no notes", async () => {
    const intel = await runCompanyIntelAgent(INPUT);

    expect(intel.style).toBe("unknown");
    expect(intel.focus).toBe("unknown");
    expect(intel.seniority).toBe("unknown");
  });

  it("does not throw when the model fails", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    expect(
      (await runCompanyIntelAgent({ ...INPUT, notes: "Two rounds, both pairing." }))
        .style
    ).toBe("unknown");
  });

  it("does not throw when the model returns an invalid enum value", async () => {
    setStructuredReplies([
      { style: "vibes-based", focus: "product", seniority: "mid" },
    ]);

    const intel = await runCompanyIntelAgent({
      ...INPUT,
      notes: "Two rounds, both pairing.",
    });

    // The whole classification is discarded, not just the bad field. A model
    // that invented one value has not earned trust in the other two.
    expect(intel.style).toBe("unknown");
    expect(intel.focus).toBe("unknown");
  });
});

describe("what it produces", () => {
  it("classifies from the candidate's notes", async () => {
    const intel = await runCompanyIntelAgent({
      ...INPUT,
      notes: "Pairing on a real bug, no whiteboard. Heavy on Kubernetes.",
    });

    expect(intel.style).toBe("practical");
    expect(intel.focus).toBe("infrastructure");
    expect(intel.seniority).toBe("senior");
  });

  it("produces an item that satisfies the stored schema", async () => {
    const intel = await runCompanyIntelAgent({ ...INPUT, notes: "A recruiter call." });

    expect(CompanyIntelSchema.safeParse(intel).success).toBe(true);
  });

  // sessionId and createdAt are the server's to set, for the same reason they
  // are in the Gap agent: a model that could supply its own sessionId could
  // write intel onto somebody else's interview.
  it("stamps the session and time itself rather than trusting the model", async () => {
    setStructuredReplies([
      { ...CLASSIFIED, sessionId: "somebody-else", createdAt: "1999-01-01T00:00:00.000Z" },
    ]);

    const intel = await runCompanyIntelAgent({ ...INPUT, notes: "A recruiter call." });

    expect(intel.sessionId).toBe(INPUT.sessionId);
    expect(intel.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  // There is no search in v1 — this is always 0.
  it("always reports zero sources", async () => {
    const intel = await runCompanyIntelAgent({ ...INPUT, notes: "A recruiter call." });

    expect(intel.sourceCount).toBe(0);
  });

  it("carries the candidate's own notes through verbatim", async () => {
    const intel = await runCompanyIntelAgent({
      ...INPUT,
      notes: "Two rounds, second is a take-home review.",
    });

    expect(intel.notes).toBe("Two rounds, second is a take-home review.");
  });

  // Omitted rather than stored empty, so `notes` being present always means
  // the candidate actually wrote something.
  it("omits notes entirely when the candidate gave none", async () => {
    expect(await runCompanyIntelAgent(INPUT)).not.toHaveProperty("notes");
  });

  it("omits notes that are only whitespace", async () => {
    const intel = await runCompanyIntelAgent({ ...INPUT, notes: "   \n " });

    expect(intel.notes).toBeUndefined();
  });

  it("parses a classification the model wrote as prose", async () => {
    setStructuredTextReplies([
      "```json\n" + JSON.stringify(CLASSIFIED) + "\n```",
    ]);

    expect(
      (await runCompanyIntelAgent({ ...INPUT, notes: "A recruiter call." })).style
    ).toBe("practical");
  });
});

describe("what it refuses to pay for", () => {
  // Nothing to read means nothing to classify. Asking the model to read a
  // blank note is a paid call whose only honest answer is the one we already
  // have.
  it("skips the model entirely when there are no notes", async () => {
    await runCompanyIntelAgent(INPUT);

    expect(structuredCallCount()).toBe(0);
  });

  it("classifies once notes are present", async () => {
    const intel = await runCompanyIntelAgent({
      ...INPUT,
      notes: "They pair on a real bug for an hour.",
    });

    expect(structuredCallCount()).toBe(1);
    expect(intel.style).toBe("practical");
  });

  // One attempt, unlike the Gap agent's two. There is nothing to salvage on a
  // retry here: the fallback is already a valid answer.
  it("does not retry a failed classification", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    await runCompanyIntelAgent({ ...INPUT, notes: "A recruiter call." });

    expect(structuredCallCount()).toBe(1);
  });

  it("truncates an absurd company name", async () => {
    const intel = await runCompanyIntelAgent({
      ...INPUT,
      company: "A".repeat(500),
      notes: "A recruiter call.",
    });

    expect(intel.company.length).toBeLessThanOrEqual(120);
    expect(CompanyIntelSchema.safeParse(intel).success).toBe(true);
  });
});

describe("intelIsEmpty", () => {
  it("is true for all-unknown with no notes — nothing to put in a prompt", async () => {
    expect(intelIsEmpty(await runCompanyIntelAgent(INPUT))).toBe(true);
  });

  // The notes alone are worth rendering even when nothing classified: the
  // candidate told us something about the process, and that is the highest
  // quality input this agent ever gets.
  it("is false when the candidate wrote notes, however unknown the rest", async () => {
    setStructuredReplies([
      { style: "unknown", focus: "unknown", seniority: "unknown" },
    ]);

    const intel = await runCompanyIntelAgent({
      ...INPUT,
      notes: "Recruiter said it is one long pairing session.",
    });

    expect(intelIsEmpty(intel)).toBe(false);
  });
});
