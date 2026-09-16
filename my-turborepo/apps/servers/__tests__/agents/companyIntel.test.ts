import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { CompanyIntelSchema, intelIsEmpty } from "@repo/shared";
// The SHARED stubs. lib/bedrock and lib/ssm are each registered exactly once
// for the whole process — see the headers of those helpers.
import {
  resetStructuredStub,
  setStructuredFailure,
  setStructuredReplies,
  setStructuredTextReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";
import { resetSsmStub, setSecretFailure, getSecret } from "../helpers/ssmStub";
import {
  installSearchStub,
  resetSearchStub,
  restoreSearchStub,
  searchQueries,
  setSearchEmpty,
  setSearchHangs,
  setSearchMalformed,
  setSearchPartialFailure,
  setSearchResults,
  setSearchStatus,
  setSearchThrows,
} from "../helpers/searchStub";

const { runCompanyIntelAgent } = await import("../../agents/companyIntel");

const INPUT = {
  company: "Acme Systems",
  sessionId: "01J000000000000000000000",
};

const SNIPPETS = [
  { title: "Acme interview guide", content: "Pairing on a real bug, no whiteboard." },
  { title: "Acme engineering", content: "Go, Kubernetes, and a lot of Postgres." },
];

const CLASSIFIED = { style: "practical", focus: "infrastructure", seniority: "senior" };

beforeAll(installSearchStub);
afterAll(restoreSearchStub);

beforeEach(() => {
  resetStructuredStub();
  resetSsmStub();
  resetSearchStub();
  setSearchResults(SNIPPETS, SNIPPETS);
  setStructuredReplies([CLASSIFIED]);
});

describe("the search it runs", () => {
  // Exactly two, by specification. Each is a paid call and a third buys
  // vocabulary rather than signal.
  it("sends exactly two queries", async () => {
    await runCompanyIntelAgent(INPUT);

    expect(searchQueries()).toHaveLength(2);
  });

  it("sends the two queries the spec names", async () => {
    await runCompanyIntelAgent(INPUT);

    expect(searchQueries()).toEqual([
      "Acme Systems interview process",
      "Acme Systems engineering blog tech stack",
    ]);
  });

  // The key never comes from the environment. This is the assertion that keeps
  // it that way — lib/ssm is the only path to it, so a future "just read it
  // from process.env" fails here.
  it("reads its API key from SSM", async () => {
    await runCompanyIntelAgent(INPUT);

    expect(getSecret).toHaveBeenCalled();
  });

  // The constraint that makes this external call acceptable at all: a company
  // name goes out and nothing else. No resume, no transcript, no user id.
  it("sends nothing but the company name", async () => {
    await runCompanyIntelAgent({
      ...INPUT,
      notes: "A recruiter said there is a take-home.",
    });

    for (const query of searchQueries()) {
      expect(query).not.toContain("recruiter");
      expect(query).not.toContain(INPUT.sessionId);
    }
  });
});

// Every one of these is a path the spec requires to end in a working interview.
describe("degradation is the default path", () => {
  it("returns all-unknown when search finds nothing", async () => {
    setSearchEmpty();

    const intel = await runCompanyIntelAgent(INPUT);

    expect(intel.style).toBe("unknown");
    expect(intel.focus).toBe("unknown");
    expect(intel.seniority).toBe("unknown");
  });

  it("does not throw when the search API throws", async () => {
    setSearchThrows(new Error("ECONNREFUSED"));

    expect((await runCompanyIntelAgent(INPUT)).sourceCount).toBe(0);
  });

  it("does not throw when the search API returns an error status", async () => {
    setSearchStatus(503);

    expect((await runCompanyIntelAgent(INPUT)).sourceCount).toBe(0);
  });

  it("does not throw when the search response does not parse", async () => {
    setSearchMalformed();

    expect((await runCompanyIntelAgent(INPUT)).sourceCount).toBe(0);
  });

  // The secret missing is a half-finished deployment, and it must not take the
  // plan down with it.
  it("does not throw when the API key cannot be read", async () => {
    setSecretFailure(new Error("ParameterNotFound"));

    expect((await runCompanyIntelAgent(INPUT)).style).toBe("unknown");
  });

  it("does not throw when the model fails", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    expect((await runCompanyIntelAgent(INPUT)).style).toBe("unknown");
  });

  it("does not throw when the model returns an invalid enum value", async () => {
    setStructuredReplies([
      { style: "vibes-based", focus: "product", seniority: "mid" },
    ]);

    const intel = await runCompanyIntelAgent(INPUT);

    // The whole classification is discarded, not just the bad field. A model
    // that invented one value has not earned trust in the other two.
    expect(intel.style).toBe("unknown");
    expect(intel.focus).toBe("unknown");
  });

  it("times out a hanging search rather than holding the plan open", async () => {
    setSearchHangs();

    const started = Date.now();
    const intel = await runCompanyIntelAgent(INPUT);

    expect(intel.sourceCount).toBe(0);
    // Well under the stub's deliberate overrun, so this passes only if the
    // AbortController fired rather than the request completing.
    expect(Date.now() - started).toBeLessThan(4_000 + 1_500);
  }, 10_000);

  // One query failing is not a reason to discard the other's snippets — and
  // "both failed" is the only shape that produces nothing.
  it("keeps the snippets from a query that worked when the other threw", async () => {
    setSearchPartialFailure(SNIPPETS, new Error("second query refused"));

    const intel = await runCompanyIntelAgent(INPUT);

    expect(intel.sourceCount).toBe(2);
    expect(intel.style).toBe("practical");
  });
});

describe("what it produces", () => {
  it("classifies from the snippets", async () => {
    const intel = await runCompanyIntelAgent(INPUT);

    expect(intel.style).toBe("practical");
    expect(intel.focus).toBe("infrastructure");
    expect(intel.seniority).toBe("senior");
  });

  it("produces an item that satisfies the stored schema", async () => {
    const intel = await runCompanyIntelAgent(INPUT);

    expect(CompanyIntelSchema.safeParse(intel).success).toBe(true);
  });

  // sessionId and createdAt are the server's to set, for the same reason they
  // are in the Gap agent: a model that could supply its own sessionId could
  // write intel onto somebody else's interview.
  it("stamps the session and time itself rather than trusting the model", async () => {
    setStructuredReplies([
      { ...CLASSIFIED, sessionId: "somebody-else", createdAt: "1999-01-01T00:00:00.000Z" },
    ]);

    const intel = await runCompanyIntelAgent(INPUT);

    expect(intel.sessionId).toBe(INPUT.sessionId);
    expect(intel.createdAt).not.toBe("1999-01-01T00:00:00.000Z");
  });

  it("records how many snippets the reading came from", async () => {
    const intel = await runCompanyIntelAgent(INPUT);

    expect(intel.sourceCount).toBe(4);
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

    expect((await runCompanyIntelAgent(INPUT)).style).toBe("practical");
  });
});

describe("what it refuses to pay for", () => {
  // Nothing to read means nothing to classify. Asking the model to read an
  // empty page is a paid call whose only honest answer is the one we already
  // have.
  it("skips the model entirely when there are no snippets and no notes", async () => {
    setSearchEmpty();

    await runCompanyIntelAgent(INPUT);

    expect(structuredCallCount()).toBe(0);
  });

  // But notes alone ARE worth a call — the candidate wrote something, and
  // classifying it is the only chance to use it as more than free text.
  it("still classifies when search found nothing but the candidate wrote notes", async () => {
    setSearchEmpty();

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

    await runCompanyIntelAgent(INPUT);

    expect(structuredCallCount()).toBe(1);
  });

  it("truncates an absurd company name rather than searching for it", async () => {
    const intel = await runCompanyIntelAgent({
      ...INPUT,
      company: "A".repeat(500),
    });

    expect(intel.company.length).toBeLessThanOrEqual(120);
    expect(CompanyIntelSchema.safeParse(intel).success).toBe(true);
  });
});

describe("intelIsEmpty", () => {
  it("is true for all-unknown with no notes — nothing to put in a prompt", async () => {
    setSearchEmpty();

    expect(intelIsEmpty(await runCompanyIntelAgent(INPUT))).toBe(true);
  });

  // The notes alone are worth rendering even when nothing classified: the
  // candidate told us something about the process, and that is the highest
  // quality input this agent ever gets.
  it("is false when the candidate wrote notes, however unknown the rest", async () => {
    setSearchEmpty();
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
