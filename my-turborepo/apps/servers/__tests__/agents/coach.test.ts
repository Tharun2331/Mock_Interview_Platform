import { beforeEach, describe, expect, it } from "bun:test";
import {
  COACH_LIMITS,
  CoachReportSchema,
  trendDirection,
  type CoachReport,
  type RoadmapItem,
  type RoadmapTrack,
  type UserSessionSummary,
} from "@repo/shared";
// The SHARED Bedrock stub. lib/bedrock is one module and mock.module replaces
// all of it — see the helper's header.
import {
  lastStructuredCall,
  resetStructuredStub,
  setStructuredFailure,
  setStructuredReplies,
  setStructuredTextReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";

const { runCoachAgent, analyseHistory, groupByTopic } = await import(
  "../../agents/coach"
);

// The agent now returns { report, prose, generated } so a caller can cache the
// prose it produced. Almost every test here is about the report, so they go
// through this rather than destructuring in forty places. The cache tests at the
// bottom call runCoachAgent directly.
const reportFor = async (
  input: Parameters<typeof runCoachAgent>[0]
): Promise<CoachReport> => (await runCoachAgent(input)).report;

let clock = 0;

/** One finished interview. `completedAt` advances by default so a list built
 *  without explicit dates is still in a defined order. */
function session(overrides: Partial<UserSessionSummary> = {}): UserSessionSummary {
  clock += 1;
  return {
    type: "user_session_summary",
    sessionId: `01J00000000000000000000${clock}`,
    completedAt: `2026-09-${String(clock).padStart(2, "0")}T10:00:00.000Z`,
    role: "Backend Engineer",
    overallScore: 5,
    topStrength: "correctness",
    topWeakness: "depth",
    questionCount: 8,
    ...overrides,
  };
}

/** A session carrying the narrative Part 2 writes. This is what gives the
 *  technical track something real to name. */
function narrated(text: string, overrides: Partial<UserSessionSummary> = {}) {
  return session({
    averages: { correctness: 4, clarity: 7, depth: 3 },
    summary: { summaryText: text, flaggedExamples: [] },
    ...overrides,
  });
}

const PROSE = {
  topics: [
    {
      topic: "Backend Engineer",
      summary: "You are getting steadier at explaining your own systems.",
      communicationFocus: ["Name the tradeoff before the solution."],
      technicalFocus: [
        "Read up on consistent hashing.",
        "Revise queue delivery guarantees.",
      ],
    },
  ],
};

function itemFor(
  report: CoachReport,
  topic: string,
  track: RoadmapTrack
): RoadmapItem | undefined {
  return report.roadmap.find(
    (item) => item.topic === topic && item.track === track
  );
}

beforeEach(() => {
  clock = 0;
  resetStructuredStub();
  setStructuredReplies([PROSE]);
});

describe("a candidate with no finished interviews", () => {
  it("returns an empty report rather than failing", async () => {
    expect(await reportFor({ summaries: [] })).toEqual({
      trends: [],
      roadmap: [],
    });
  });

  // Nothing to coach and nothing to say about it. Paying a model to observe
  // that is paying for the word "none".
  it("does not call the model at all", async () => {
    await reportFor({ summaries: [] });

    expect(structuredCallCount()).toBe(0);
  });

  it("still satisfies the response schema", async () => {
    const report = await reportFor({ summaries: [] });

    expect(CoachReportSchema.safeParse(report).success).toBe(true);
  });
});

describe("a candidate with exactly one interview", () => {
  // One interview is a position, not a trend. Reporting it as "flat" would
  // claim a stability the data cannot show.
  it("produces no trend", async () => {
    expect((await reportFor({ summaries: [session()] })).trends).toEqual([]);
  });

  // But it IS enough to say what to work on, which is the more useful half.
  it("still produces a roadmap, on both tracks", async () => {
    const report = await reportFor({ summaries: [session()] });

    expect(report.roadmap.map((item) => item.track).sort()).toEqual([
      "communication",
      "technical",
    ]);
  });

  it("still satisfies the response schema", async () => {
    const report = await reportFor({ summaries: [session()] });

    expect(CoachReportSchema.safeParse(report).success).toBe(true);
  });
});

// The split is the point of Part 3: these are learned differently, and one of
// them is far better evidenced than the other.
describe("the two-track roadmap", () => {
  it("emits one item per track per topic", async () => {
    const report = await reportFor({
      summaries: [
        session({ role: "Backend Engineer" }),
        session({ role: "Frontend Engineer" }),
      ],
    });

    expect(report.roadmap).toHaveLength(4);
    expect(itemFor(report, "Backend Engineer", "communication")).toBeDefined();
    expect(itemFor(report, "Backend Engineer", "technical")).toBeDefined();
  });

  // Communication is scored directly — clarity is assigned on every answer — so
  // its number is the clarity mean rather than the overall.
  it("scores the communication track on clarity", async () => {
    const report = await reportFor({
      summaries: [
        session({ averages: { correctness: 9, clarity: 2, depth: 9 } }),
      ],
    });

    expect(itemFor(report, "Backend Engineer", "communication")?.avgScore).toBe(2);
  });

  it("scores the technical track on correctness and depth", async () => {
    const report = await reportFor({
      summaries: [
        session({ averages: { correctness: 2, clarity: 9, depth: 4 } }),
      ],
    });

    expect(itemFor(report, "Backend Engineer", "technical")?.avgScore).toBe(3);
  });

  // The assertion the spec asks for by name, and the honest part of the design:
  // correctness and depth are read off whichever questions the interviewer
  // happened to ask, which is a sample of what someone knows, not an exam.
  it("always marks technical items tentative", async () => {
    const report = await reportFor({
      summaries: [
        session({ averages: { correctness: 9, clarity: 9, depth: 9 } }),
        session({ averages: { correctness: 9, clarity: 9, depth: 9 } }),
      ],
    });

    for (const item of report.roadmap.filter((row) => row.track === "technical")) {
      expect(item.confidence).toBe("tentative");
    }
  });

  it("marks communication confident when clarity was actually recorded", async () => {
    const report = await reportFor({
      summaries: [session({ averages: { correctness: 5, clarity: 5, depth: 5 } })],
    });

    expect(itemFor(report, "Backend Engineer", "communication")?.confidence).toBe(
      "confident"
    );
  });

  // Rows written before averages were carried. Falling back to the overall
  // score is fine; claiming the same confidence for it is not.
  it("drops communication to tentative when no clarity was recorded", async () => {
    const report = await reportFor({ summaries: [session()] });

    expect(itemFor(report, "Backend Engineer", "communication")?.confidence).toBe(
      "tentative"
    );
  });

  it("keeps the two tracks' focus points separate", async () => {
    const report = await reportFor({ summaries: [session()] });

    expect(
      itemFor(report, "Backend Engineer", "communication")?.focusPoints
    ).toEqual(["Name the tradeoff before the solution."]);
    expect(itemFor(report, "Backend Engineer", "technical")?.focusPoints).toEqual([
      "Read up on consistent hashing.",
      "Revise queue delivery guarantees.",
    ]);
  });
});

describe("roadmap priority ordering", () => {
  // 1 is the most urgent, so the worst average comes first — across tracks, not
  // within a topic. The single worst thing a candidate does is where they
  // should start, whichever track it belongs to.
  it("orders by score across both tracks", async () => {
    const report = await reportFor({
      summaries: [
        session({ averages: { correctness: 9, clarity: 1, depth: 9 } }),
      ],
    });

    expect(report.roadmap[0]?.track).toBe("communication");
    expect(report.roadmap[0]?.priority).toBe(1);
  });

  it("numbers priorities consecutively from 1", async () => {
    const report = await reportFor({
      summaries: [
        session({ role: "A", overallScore: 7 }),
        session({ role: "B", overallScore: 4 }),
      ],
    });

    expect(report.roadmap.map((item) => item.priority)).toEqual([1, 2, 3, 4]);
  });

  // Ties would otherwise order by Map insertion, which makes the same input
  // produce a different report on a re-run.
  it("breaks ties stably by topic then track", async () => {
    const first = await reportFor({
      summaries: [session({ role: "Zebra" }), session({ role: "Alpha" })],
    });
    const second = await reportFor({
      summaries: [session({ role: "Alpha" }), session({ role: "Zebra" })],
    });

    expect(first.roadmap.map((item) => `${item.topic}/${item.track}`)).toEqual(
      second.roadmap.map((item) => `${item.topic}/${item.track}`)
    );
  });

  it("caps the roadmap", () => {
    const summaries: UserSessionSummary[] = [];
    for (let index = 0; index < COACH_LIMITS.MAX_ROADMAP_ITEMS; index += 1) {
      summaries.push(session({ role: `Role ${index}` }));
    }

    expect(analyseHistory(summaries).roadmap.length).toBeLessThanOrEqual(
      COACH_LIMITS.MAX_ROADMAP_ITEMS
    );
  });
});

describe("trend calculation across sessions", () => {
  it("reports a rising series as improving", async () => {
    const report = await reportFor({
      summaries: [
        session({ overallScore: 3 }),
        session({ overallScore: 4 }),
        session({ overallScore: 7 }),
        session({ overallScore: 8 }),
      ],
    });

    expect(report.trends[0]?.direction).toBe("improving");
  });

  it("reports a falling series as declining", async () => {
    const report = await reportFor({
      summaries: [
        session({ overallScore: 8 }),
        session({ overallScore: 7 }),
        session({ overallScore: 4 }),
        session({ overallScore: 3 }),
      ],
    });

    expect(report.trends[0]?.direction).toBe("declining");
  });

  // Movement below the epsilon is a different set of questions, not a change in
  // the candidate. Calling it improvement would be flattery.
  it("reports small movement as flat", async () => {
    const report = await reportFor({
      summaries: [session({ overallScore: 6 }), session({ overallScore: 6.2 })],
    });

    expect(report.trends[0]?.direction).toBe("flat");
  });

  // The query returns newest-first because that is what the history list wants.
  // A chart drawn in that order reads improvement as decline.
  it("orders the score history oldest first regardless of input order", async () => {
    const older = session({ completedAt: "2026-09-01T10:00:00.000Z", overallScore: 3 });
    const newer = session({ completedAt: "2026-09-20T10:00:00.000Z", overallScore: 8 });

    const report = await reportFor({ summaries: [newer, older] });
    const history = report.trends[0]?.scoreHistory ?? [];

    expect(history[0]?.avgScore).toBe(3);
    expect(history[1]?.avgScore).toBe(8);
    expect(report.trends[0]?.direction).toBe("improving");
  });

  // Each role is its own line. A candidate practising two roles is not one
  // series, and averaging them hides both.
  it("keeps a separate trend per topic", async () => {
    const report = await reportFor({
      summaries: [
        session({ role: "Backend Engineer" }),
        session({ role: "Backend Engineer" }),
        session({ role: "Frontend Engineer" }),
        session({ role: "Frontend Engineer" }),
      ],
    });

    expect(report.trends.map((trend) => trend.topic).sort()).toEqual([
      "Backend Engineer",
      "Frontend Engineer",
    ]);
  });

  // A topic with one interview has no trend even when another has many — but it
  // still earns roadmap items.
  it("omits a one-interview topic from trends but not from the roadmap", async () => {
    const report = await reportFor({
      summaries: [
        session({ role: "Backend Engineer" }),
        session({ role: "Backend Engineer" }),
        session({ role: "Data Engineer" }),
      ],
    });

    expect(report.trends.map((trend) => trend.topic)).toEqual(["Backend Engineer"]);
    expect(report.roadmap.map((item) => item.topic)).toContain("Data Engineer");
  });
});

// The reason Part 3 reads session summaries rather than score rows: without
// them the model had a role name, a number and a dimension, and could only
// produce delivery advice because it had never been told what was asked.
describe("the session narratives", () => {
  it("passes what each interview showed into the prompt", async () => {
    await reportFor({
      summaries: [
        narrated("You could not justify the caching strategy you chose."),
        narrated("Tradeoffs on database indexing went unexplained."),
      ],
    });

    const call = lastStructuredCall() as { prompt: string };
    expect(call.prompt).toContain("caching strategy");
    expect(call.prompt).toContain("database indexing");
  });

  it("puts the most recent interview first", async () => {
    await reportFor({
      summaries: [
        narrated("OLDEST", { completedAt: "2026-09-01T10:00:00.000Z" }),
        narrated("NEWEST", { completedAt: "2026-09-20T10:00:00.000Z" }),
      ],
    });

    const call = lastStructuredCall() as { prompt: string };
    expect(call.prompt.indexOf("NEWEST")).toBeLessThan(call.prompt.indexOf("OLDEST"));
  });

  // Said explicitly rather than omitted. An absent section reads to a model as
  // an invitation to fill the gap from the job title, which is the one thing
  // the system prompt forbids.
  it("says so when a topic has no narratives at all", async () => {
    await reportFor({ summaries: [session()] });

    const call = lastStructuredCall() as { prompt: string };
    expect(call.prompt).toContain("(no summaries recorded)");
  });

  it("tells the model to leave the technical track empty rather than guess", async () => {
    await reportFor({ summaries: [session()] });

    const call = lastStructuredCall() as { system: string };
    expect(call.system).toContain("empty technicalFocus rather than guessing");
  });
});

describe("what the model is allowed to contribute", () => {
  // The guard that makes invention structural rather than instructed.
  it("discards a topic the candidate never practised", async () => {
    setStructuredReplies([
      {
        topics: [
          {
            topic: "Kubernetes",
            summary: "Invented.",
            communicationFocus: ["Nope."],
            technicalFocus: ["Nope."],
          },
          ...PROSE.topics,
        ],
      },
    ]);

    const report = await reportFor({ summaries: [session(), session()] });

    expect(report.roadmap.every((item) => item.topic === "Backend Engineer")).toBe(
      true
    );
    expect(JSON.stringify(report)).not.toContain("Invented.");
  });

  it("caps focus points per track", async () => {
    setStructuredReplies([
      {
        topics: [
          {
            topic: "Backend Engineer",
            summary: "Fine.",
            communicationFocus: ["a", "b", "c", "d", "e", "f"],
            technicalFocus: ["g", "h", "i", "j", "k"],
          },
        ],
      },
    ]);

    const report = await reportFor({ summaries: [session()] });

    for (const item of report.roadmap) {
      expect(item.focusPoints.length).toBeLessThanOrEqual(
        COACH_LIMITS.MAX_FOCUS_POINTS
      );
    }
  });

  it("parses a reply the model wrote as prose", async () => {
    setStructuredTextReplies(["```json\n" + JSON.stringify(PROSE) + "\n```"]);

    const report = await reportFor({ summaries: [session(), session()] });

    expect(itemFor(report, "Backend Engineer", "technical")?.focusPoints).toHaveLength(2);
  });
});

// The numbers are the part a candidate cannot work out for themselves, so a
// failed generation must not take them down with it.
describe("a failed generation", () => {
  it("still returns the trends and both tracks", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await reportFor({
      summaries: [session({ overallScore: 3 }), session({ overallScore: 8 })],
    });

    expect(report.trends[0]?.direction).toBe("improving");
    expect(report.roadmap).toHaveLength(2);
  });

  it("falls back to a summary stated from the numbers", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await reportFor({
      summaries: [session({ overallScore: 3 }), session({ overallScore: 8 })],
    });

    expect(report.trends[0]?.summary).toContain("Backend Engineer");
  });

  it("leaves focus points empty rather than inventing them", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await reportFor({ summaries: [session()] });

    for (const item of report.roadmap) expect(item.focusPoints).toEqual([]);
  });

  it("still satisfies the response schema", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await reportFor({ summaries: [session(), session()] });

    expect(CoachReportSchema.safeParse(report).success).toBe(true);
  });

  // One attempt, like Company Intel and unlike the Gap agent. There is nothing
  // to salvage on a retry: the fallback is already a usable answer.
  it("does not retry", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    await reportFor({ summaries: [session()] });

    expect(structuredCallCount()).toBe(1);
  });
});

describe("sessions with no recorded role", () => {
  it("groups them under one topic rather than one each", () => {
    const grouped = groupByTopic([
      session({ role: undefined }),
      session({ role: undefined }),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.points).toHaveLength(2);
  });

  it("gives them a readable label", async () => {
    const report = await reportFor({ summaries: [session({ role: undefined })] });

    expect(report.roadmap[0]?.topic).toBe("General practice");
  });
});

// Exported from the shared package because it is the one piece of Coach
// arithmetic worth testing on its own.
describe("trendDirection", () => {
  it("is flat for fewer than two points", () => {
    expect(trendDirection([])).toBe("flat");
    expect(trendDirection([7])).toBe("flat");
  });

  it("drops the middle reading on an odd count so the halves match", () => {
    expect(trendDirection([2, 2, 5, 8, 8])).toBe("improving");
  });

  // Comparing halves damps an outlier; it does not neutralise one, and the
  // distinction is worth pinning.
  it("is not decided by a spike in the middle", () => {
    expect(trendDirection([3, 4, 9, 6, 7])).toBe("improving");
  });

  it("still reports a bad finish as declining", () => {
    expect(trendDirection([5, 5, 5, 5, 5, 1])).toBe("declining");
  });
});

// The caching seam. The agent does not know what a cache is — it takes prose in
// and hands prose out, and the route decides whether either is worth using.
describe("runCoachAgent prose reuse", () => {
  const two = () => [session(), session()];

  it("hands back the prose it generated, keyed by topic", async () => {
    setStructuredReplies([
      {
        topics: [
          {
            topic: "Backend Engineer",
            summary: "Steady across both rounds.",
            communicationFocus: ["Lead with the outcome"],
            technicalFocus: ["Revisit index selection"],
          },
        ],
      },
    ]);

    const { prose, generated } = await runCoachAgent({ summaries: two() });

    expect(generated).toBe(true);
    expect(prose).toEqual({
      topics: [
        {
          topic: "Backend Engineer",
          summary: "Steady across both rounds.",
          communicationFocus: ["Lead with the outcome"],
          technicalFocus: ["Revisit index selection"],
        },
      ],
    });
  });

  it("does not call Bedrock when given prose to reuse", async () => {
    const { prose } = await runCoachAgent({ summaries: two() });
    const before = structuredCallCount();

    const second = await runCoachAgent({ summaries: two(), cachedProse: prose });

    expect(structuredCallCount()).toBe(before);
    expect(second.generated).toBe(false);
  });

  it("produces the same report from reused prose as from a fresh call", async () => {
    // The property that makes caching safe to do at all: a hit and a miss are
    // indistinguishable to the candidate reading the page.
    setStructuredReplies([
      {
        topics: [
          {
            topic: "Backend Engineer",
            summary: "Steady across both rounds.",
            communicationFocus: ["Lead with the outcome"],
            technicalFocus: ["Revisit index selection"],
          },
        ],
      },
    ]);

    // The same rows both times. `session()` advances the clock, so building
    // them twice would give the two runs different dates and compare nothing.
    const summaries = two();

    const fresh = await runCoachAgent({ summaries });
    const reused = await runCoachAgent({ summaries, cachedProse: fresh.prose });

    expect(reused.report).toEqual(fresh.report);
  });

  it("reports no prose when the model call fails, so nothing empty is cached", async () => {
    // Caching a failed generation would turn one transient Bedrock outage into
    // a permanently numbers-only report — it would look fresh forever.
    setStructuredFailure(new Error("throttled"));

    const { report, prose, generated } = await runCoachAgent({ summaries: two() });

    expect(generated).toBe(true);
    expect(prose).toBeNull();
    expect(report.roadmap.length).toBeGreaterThan(0);
  });

  it("reports no prose for a candidate with no roadmap", async () => {
    const { prose, generated } = await runCoachAgent({ summaries: [] });

    expect(prose).toBeNull();
    expect(generated).toBe(false);
  });

  it("drops a cached topic the analysis no longer produces", async () => {
    // Stored prose is model output that has been sitting in a table. A role the
    // candidate has stopped practising must not reappear in the roadmap purely
    // because it was written down once.
    const stale = {
      topics: [
        {
          topic: "A Role They Stopped Practising",
          summary: "Should not appear.",
          communicationFocus: ["Nor this"],
          technicalFocus: [],
        },
      ],
    };

    const { report } = await runCoachAgent({
      summaries: two(),
      cachedProse: stale,
    });

    expect(report.roadmap.map((item) => item.topic)).not.toContain(
      "A Role They Stopped Practising"
    );
    for (const item of report.roadmap) expect(item.focusPoints).toEqual([]);
  });

  it("treats a null cache as a miss rather than as empty prose", async () => {
    const before = structuredCallCount();

    await runCoachAgent({ summaries: two(), cachedProse: null });

    expect(structuredCallCount()).toBe(before + 1);
  });
});
