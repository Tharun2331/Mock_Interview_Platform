import { beforeEach, describe, expect, it } from "bun:test";
import {
  COACH_LIMITS,
  CoachReportSchema,
  trendDirection,
  type UserSessionSummary,
} from "@repo/shared";
// The SHARED Bedrock stub. lib/bedrock is one module and mock.module replaces
// all of it — see the helper's header.
import {
  resetStructuredStub,
  setStructuredFailure,
  setStructuredReplies,
  setStructuredTextReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";

const { runCoachAgent, analyseHistory, weakestDimension, groupByTopic } =
  await import("../../agents/coach");

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

const PROSE = {
  topics: [
    {
      topic: "Backend Engineer",
      summary: "You are getting steadier at explaining your own systems.",
      focusPoints: ["Name the tradeoff before the solution.", "Quantify one result."],
    },
  ],
};

beforeEach(() => {
  clock = 0;
  resetStructuredStub();
  setStructuredReplies([PROSE]);
});

describe("a candidate with no finished interviews", () => {
  it("returns an empty report rather than failing", async () => {
    const report = await runCoachAgent({ summaries: [] });

    expect(report).toEqual({ trends: [], roadmap: [] });
  });

  // Nothing to coach and nothing to say about it. Paying a model to observe
  // that is paying for the word "none".
  it("does not call the model at all", async () => {
    await runCoachAgent({ summaries: [] });

    expect(structuredCallCount()).toBe(0);
  });

  it("still satisfies the response schema", async () => {
    const report = await runCoachAgent({ summaries: [] });

    expect(CoachReportSchema.safeParse(report).success).toBe(true);
  });
});

describe("a candidate with exactly one interview", () => {
  // One interview is a position, not a trend. Reporting it as "flat" would
  // claim a stability the data cannot show.
  it("produces no trend", async () => {
    const report = await runCoachAgent({ summaries: [session()] });

    expect(report.trends).toEqual([]);
  });

  // But it IS enough to say what to work on, which is the more useful half.
  it("still produces a roadmap", async () => {
    const report = await runCoachAgent({ summaries: [session({ overallScore: 4 })] });

    expect(report.roadmap).toHaveLength(1);
    expect(report.roadmap[0]?.topic).toBe("Backend Engineer");
    expect(report.roadmap[0]?.avgScore).toBe(4);
    expect(report.roadmap[0]?.priority).toBe(1);
  });

  it("names the weak dimension from the stored averages", async () => {
    const report = await runCoachAgent({
      summaries: [
        session({ averages: { correctness: 8, clarity: 3, depth: 7 } }),
      ],
    });

    expect(report.roadmap[0]?.weakDimension).toBe("clarity");
  });
});

describe("trend calculation across sessions", () => {
  it("reports a rising series as improving", async () => {
    const report = await runCoachAgent({
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
    const report = await runCoachAgent({
      summaries: [
        session({ overallScore: 8 }),
        session({ overallScore: 7 }),
        session({ overallScore: 4 }),
        session({ overallScore: 3 }),
      ],
    });

    expect(report.trends[0]?.direction).toBe("declining");
  });

  // Movement below the epsilon is a different set of questions, not a change
  // in the candidate. Calling it improvement would be flattery.
  it("reports small movement as flat", async () => {
    const report = await runCoachAgent({
      summaries: [session({ overallScore: 6 }), session({ overallScore: 6.2 })],
    });

    expect(report.trends[0]?.direction).toBe("flat");
  });

  // The query returns newest-first because that is what the history list
  // wants. A chart drawn in that order reads improvement as decline.
  it("orders the score history oldest first regardless of input order", async () => {
    const older = session({
      completedAt: "2026-09-01T10:00:00.000Z",
      overallScore: 3,
    });
    const newer = session({
      completedAt: "2026-09-20T10:00:00.000Z",
      overallScore: 8,
    });

    const report = await runCoachAgent({ summaries: [newer, older] });
    const history = report.trends[0]?.scoreHistory ?? [];

    expect(history[0]?.avgScore).toBe(3);
    expect(history[1]?.avgScore).toBe(8);
    expect(report.trends[0]?.direction).toBe("improving");
  });

  it("carries one point per interview", async () => {
    const report = await runCoachAgent({
      summaries: [session(), session(), session()],
    });

    expect(report.trends[0]?.scoreHistory).toHaveLength(3);
  });

  // Each role is its own line. A candidate practising two roles is not one
  // series, and averaging them hides both.
  it("keeps a separate trend per topic", async () => {
    const report = await runCoachAgent({
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

  // A topic with one interview has no trend even when another topic has many.
  it("omits a topic that has only one interview", async () => {
    const report = await runCoachAgent({
      summaries: [
        session({ role: "Backend Engineer" }),
        session({ role: "Backend Engineer" }),
        session({ role: "Data Engineer" }),
      ],
    });

    expect(report.trends.map((trend) => trend.topic)).toEqual([
      "Backend Engineer",
    ]);
    // Still on the roadmap, though — one interview is enough to say what to
    // work on.
    expect(report.roadmap.map((item) => item.topic)).toContain("Data Engineer");
  });
});

describe("roadmap priority ordering", () => {
  // 1 is the most urgent, so the worst average comes first.
  it("puts the lowest average score at priority 1", async () => {
    const report = await runCoachAgent({
      summaries: [
        session({ role: "Strong Topic", overallScore: 9 }),
        session({ role: "Weak Topic", overallScore: 2 }),
        session({ role: "Middling Topic", overallScore: 5 }),
      ],
    });

    expect(report.roadmap.map((item) => item.topic)).toEqual([
      "Weak Topic",
      "Middling Topic",
      "Strong Topic",
    ]);
    expect(report.roadmap.map((item) => item.priority)).toEqual([1, 2, 3]);
  });

  it("numbers priorities consecutively from 1", async () => {
    const report = await runCoachAgent({
      summaries: [
        session({ role: "A", overallScore: 7 }),
        session({ role: "B", overallScore: 6 }),
        session({ role: "C", overallScore: 5 }),
        session({ role: "D", overallScore: 4 }),
      ],
    });

    expect(report.roadmap.map((item) => item.priority)).toEqual([1, 2, 3, 4]);
  });

  it("ranks on the average, not on the most recent score", async () => {
    const report = await runCoachAgent({
      summaries: [
        // Ends high but averages 4.
        session({ role: "Volatile", overallScore: 1 }),
        session({ role: "Volatile", overallScore: 7 }),
        // Steady at 5.
        session({ role: "Steady", overallScore: 5 }),
        session({ role: "Steady", overallScore: 5 }),
      ],
    });

    expect(report.roadmap[0]?.topic).toBe("Volatile");
    expect(report.roadmap[0]?.avgScore).toBe(4);
  });

  // Ties would otherwise order by Map insertion, which makes the same input
  // produce different reports on different runs.
  it("breaks ties stably by topic name", async () => {
    const report = await runCoachAgent({
      summaries: [
        session({ role: "Zebra", overallScore: 5 }),
        session({ role: "Alpha", overallScore: 5 }),
      ],
    });

    expect(report.roadmap.map((item) => item.topic)).toEqual(["Alpha", "Zebra"]);
  });
});

describe("what the model is allowed to contribute", () => {
  it("uses the model's summary and focus points", async () => {
    const report = await runCoachAgent({
      summaries: [session(), session()],
    });

    expect(report.trends[0]?.summary).toBe(
      "You are getting steadier at explaining your own systems."
    );
    expect(report.roadmap[0]?.focusPoints).toEqual([
      "Name the tradeoff before the solution.",
      "Quantify one result.",
    ]);
  });

  // The guard that makes invention structural rather than instructed: a topic
  // the analysis never produced is discarded on merge, so the model cannot add
  // a subject the candidate never practised.
  it("discards a topic the candidate never practised", async () => {
    setStructuredReplies([
      {
        topics: [
          { topic: "Kubernetes", summary: "Invented.", focusPoints: ["Nope."] },
          ...PROSE.topics,
        ],
      },
    ]);

    const report = await runCoachAgent({ summaries: [session(), session()] });

    expect(report.roadmap.map((item) => item.topic)).toEqual(["Backend Engineer"]);
    expect(JSON.stringify(report)).not.toContain("Invented.");
  });

  it("caps focus points at the limit even when the model sends more", async () => {
    setStructuredReplies([
      {
        topics: [
          {
            topic: "Backend Engineer",
            summary: "Fine.",
            focusPoints: ["a", "b", "c", "d", "e", "f"],
          },
        ],
      },
    ]);

    const report = await runCoachAgent({ summaries: [session()] });

    expect(report.roadmap[0]?.focusPoints.length).toBeLessThanOrEqual(
      COACH_LIMITS.MAX_FOCUS_POINTS
    );
  });

  it("parses a reply the model wrote as prose", async () => {
    setStructuredTextReplies(["```json\n" + JSON.stringify(PROSE) + "\n```"]);

    const report = await runCoachAgent({ summaries: [session(), session()] });

    expect(report.roadmap[0]?.focusPoints).toHaveLength(2);
  });
});

// The numbers are the part a candidate cannot work out for themselves, so a
// failed generation must not take them down with it.
describe("a failed generation", () => {
  it("still returns the trends and the roadmap", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await runCoachAgent({
      summaries: [session({ overallScore: 3 }), session({ overallScore: 8 })],
    });

    expect(report.trends[0]?.direction).toBe("improving");
    expect(report.roadmap).toHaveLength(1);
  });

  it("falls back to a summary stated from the numbers", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await runCoachAgent({
      summaries: [session({ overallScore: 3 }), session({ overallScore: 8 })],
    });

    expect(report.trends[0]?.summary).toContain("Backend Engineer");
    expect(report.trends[0]?.summary.length).toBeGreaterThan(0);
  });

  it("leaves focus points empty rather than inventing them", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await runCoachAgent({ summaries: [session()] });

    expect(report.roadmap[0]?.focusPoints).toEqual([]);
  });

  it("still satisfies the response schema", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    const report = await runCoachAgent({ summaries: [session(), session()] });

    expect(CoachReportSchema.safeParse(report).success).toBe(true);
  });

  // One attempt, like Company Intel and unlike the Gap agent. There is nothing
  // to salvage on a retry: the fallback is already a usable answer.
  it("does not retry", async () => {
    setStructuredFailure(new Error("chain exhausted"));

    await runCoachAgent({ summaries: [session()] });

    expect(structuredCallCount()).toBe(1);
  });
});

describe("weakestDimension", () => {
  it("averages the stored dimension scores", () => {
    const worst = weakestDimension([
      session({ averages: { correctness: 9, clarity: 8, depth: 2 } }),
      session({ averages: { correctness: 8, clarity: 7, depth: 3 } }),
    ]);

    expect(worst).toBe("depth");
  });

  // Rows written before `averages` was carried. A candidate's existing history
  // should still produce a roadmap rather than being skipped for predating the
  // attribute.
  it("falls back to the topWeakness labels when no averages are stored", () => {
    const worst = weakestDimension([
      session({ topWeakness: "clarity" }),
      session({ topWeakness: "clarity" }),
      session({ topWeakness: "depth" }),
    ]);

    expect(worst).toBe("clarity");
  });

  it("ignores label counts when even one row has real averages", () => {
    const worst = weakestDimension([
      session({ topWeakness: "clarity" }),
      session({
        topWeakness: "clarity",
        averages: { correctness: 9, clarity: 9, depth: 1 },
      }),
    ]);

    expect(worst).toBe("depth");
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
    const report = await runCoachAgent({
      summaries: [session({ role: undefined })],
    });

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
    // Halves are [2, 2] and [8, 8]; the middle 5 belongs to neither.
    expect(trendDirection([2, 2, 5, 8, 8])).toBe("improving");
  });

  // Comparing halves rather than first-against-last damps an outlier; it does
  // not neutralise one, and the distinction is worth pinning. A mid-series
  // spike is averaged away against its neighbours...
  it("is not decided by a spike in the middle", () => {
    expect(trendDirection([3, 4, 9, 6, 7])).toBe("improving");
  });

  // ...but a genuinely bad final round still registers, and should. Five
  // steady interviews followed by a 1 is a signal, not noise — first-against-
  // last would have called this a four-point collapse, and half-against-half
  // calls it a decline, which is the more proportionate reading of the same
  // data rather than a suppression of it.
  it("still reports a bad finish as declining", () => {
    expect(trendDirection([5, 5, 5, 5, 5, 1])).toBe("declining");
  });
});

describe("the analysis on its own", () => {
  it("caps the number of trends", () => {
    const summaries: UserSessionSummary[] = [];
    for (let index = 0; index < COACH_LIMITS.MAX_TRENDS + 3; index += 1) {
      summaries.push(session({ role: `Role ${index}` }));
      summaries.push(session({ role: `Role ${index}` }));
    }

    expect(analyseHistory(summaries).trends.length).toBeLessThanOrEqual(
      COACH_LIMITS.MAX_TRENDS
    );
  });

  // The cap should keep the lines with the most evidence behind them, not
  // whichever happened to be grouped first.
  it("keeps the most-practised topics when it caps", () => {
    const summaries: UserSessionSummary[] = [];
    for (let index = 0; index < COACH_LIMITS.MAX_TRENDS + 2; index += 1) {
      summaries.push(session({ role: `Role ${index}` }));
      summaries.push(session({ role: `Role ${index}` }));
    }
    // One topic with far more history than the rest.
    for (let index = 0; index < 5; index += 1) {
      summaries.push(session({ role: "Most practised" }));
    }

    const { trends } = analyseHistory(summaries);
    expect(trends[0]?.topic).toBe("Most practised");
  });
});
