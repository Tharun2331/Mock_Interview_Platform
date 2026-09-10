import { describe, expect, it } from "bun:test";
import {
  answerSk,
  evalSk,
  ITEM_TYPE,
  KEY_PREFIX,
  SessionAnswerSchema,
  SessionEvaluationSchema,
  SessionMetaSchema,
  sessionPk,
  sessionSk,
  SORT_KEY,
  userPk,
  type SessionMeta,
} from "../../src/schemas/session";

const NOW = "2026-09-09T12:00:00.000Z";

describe("key builders", () => {
  it("compose the documented key layout", () => {
    expect(sessionPk("abc")).toBe("SESSION#abc");
    expect(userPk("user-1")).toBe("USER#user-1");
    expect(answerSk("q1")).toBe("ANSWER#q1");
    expect(evalSk("q1")).toBe("EVAL#q1");
    expect(sessionSk("abc")).toBe("SESSION#abc");
  });

  // The USER# partition holds PROFILE and PLAN alongside session refs, and a
// history Query must filter on this prefix rather than read the partition.
  it("produce a session ref SK that the history filter matches", () => {
    expect(sessionSk("abc").startsWith(KEY_PREFIX.SESSION)).toBe(true);
  });
});

// The near-miss this encodes: EVAL_SUMMARY used to be "EVAL#SUMMARY", which sat
// inside the `begins_with("EVAL#")` range that derives completion. The Coach
// would have fired one question early on an interview still being scored.
describe("SORT_KEY.EVAL_SUMMARY", () => {
  it("sits outside the EVAL# range that completion is counted from", () => {
    expect(SORT_KEY.EVAL_SUMMARY.startsWith(KEY_PREFIX.EVAL)).toBe(false);
  });

  it("is not matched by a begins_with EVAL# scan of a session's items", () => {
    const items = [
      SORT_KEY.META,
      SORT_KEY.INPUTS,
      evalSk("q1"),
      evalSk("q2"),
      SORT_KEY.EVAL_SUMMARY,
      SORT_KEY.COACH,
    ];

    const evaluations = items.filter((sk) => sk.startsWith(KEY_PREFIX.EVAL));

    expect(evaluations).toEqual(["EVAL#q1", "EVAL#q2"]);
    expect(evaluations).toHaveLength(2);
  });

  // PROFILE and PLAN sort before "SESSION#", which is why the history query
  // needs the filter at all. Pinning the ordering keeps that reasoning honest.
  it("orders PROFILE and PLAN before session refs in the USER# partition", () => {
    expect(SORT_KEY.PROFILE < KEY_PREFIX.SESSION).toBe(true);
    expect(SORT_KEY.PLAN < KEY_PREFIX.SESSION).toBe(true);
  });
});

function meta(overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    type: ITEM_TYPE.SESSION_META,
    sessionId: "01J000000000000000000000",
    userId: "user-1",
    status: "planning",
    createdAt: NOW,
    ...overrides,
  };
}

describe("SessionMetaSchema", () => {
  // Written at status `planning`, before the Planner has run.
  it("accepts an item with no plan, role or question count yet", () => {
    const parsed = SessionMetaSchema.safeParse(meta());

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.plan).toBeUndefined();
      expect(parsed.data.role).toBeUndefined();
    }
  });

  it("defaults `type` for rows written before the attribute existed", () => {
    const { type: _dropped, ...withoutType } = meta();
    const parsed = SessionMetaSchema.safeParse(withoutType);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe(ITEM_TYPE.SESSION_META);
    }
  });

  // Items written before retention existed have no expiresAt, and TTL ignores
  // an absent attribute rather than treating it as already due.
  it("accepts an absent expiresAt but rejects a non-positive one", () => {
    expect(SessionMetaSchema.safeParse(meta()).success).toBe(true);
    expect(
      SessionMetaSchema.safeParse(meta({ expiresAt: 1_800_000_000 })).success
    ).toBe(true);
    expect(SessionMetaSchema.safeParse(meta({ expiresAt: 0 })).success).toBe(false);
    expect(SessionMetaSchema.safeParse(meta({ expiresAt: -1 })).success).toBe(false);
  });

  it("rejects a status outside the lifecycle enum", () => {
    const parsed = SessionMetaSchema.safeParse({ ...meta(), status: "cancelled" });
    expect(parsed.success).toBe(false);
  });

  it("accepts every documented lifecycle status", () => {
    for (const status of [
      "planning",
      "ready",
      "in_progress",
      "evaluating",
      "complete",
      "failed",
    ] as const) {
      expect(SessionMetaSchema.safeParse(meta({ status })).success).toBe(true);
    }
  });

  // Sessions created before profiles existed have no version, and an absent one
  // simply never matches a cached plan — a replan, not a crash.
  it("allows an absent profileVersion", () => {
    expect(SessionMetaSchema.safeParse(meta({ profileVersion: undefined })).success).toBe(
      true
    );
  });
});

describe("SessionAnswerSchema", () => {
  function answer(overrides: Record<string, unknown> = {}): unknown {
    return {
      questionId: "q1",
      questionText: "Tell me about the order pipeline.",
      questionType: "technical",
      askedAt: NOW,
      transcript: "We used Kafka consumers to coordinate state.",
      audioKey: null,
      durationMs: 42_000,
      interrupted: false,
      ...overrides,
    };
  }

  it("accepts a completed exchange with no audio", () => {
    expect(SessionAnswerSchema.safeParse(answer()).success).toBe(true);
  });

  // Nullable, not optional: "we tried and there is none" is a real state.
  it("requires audioKey to be present even when null", () => {
    const { audioKey: _dropped, ...withoutAudioKey } = answer() as Record<
      string,
      unknown
    >;
    expect(SessionAnswerSchema.safeParse(withoutAudioKey).success).toBe(false);
  });

  it("accepts an empty transcript — silence is a scoreable answer", () => {
    expect(SessionAnswerSchema.safeParse(answer({ transcript: "" })).success).toBe(
      true
    );
  });

  it("rejects a negative duration", () => {
    expect(SessionAnswerSchema.safeParse(answer({ durationMs: -1 })).success).toBe(
      false
    );
  });

  it("rejects a question type outside the enum", () => {
    expect(
      SessionAnswerSchema.safeParse(answer({ questionType: "system_design" })).success
    ).toBe(false);
  });
});

describe("SessionEvaluationSchema", () => {
  function evaluation(overrides: Record<string, unknown> = {}): unknown {
    return {
      questionId: "q1",
      correctness: 7,
      clarity: 8,
      depth: 6,
      rationale: "Named the consumer group but not the rebalance behaviour.",
      modelId: "mistral.ministral-3-8b-instruct",
      evaluatedAt: NOW,
      ...overrides,
    };
  }

  it("accepts scores across the full 0–10 band", () => {
    expect(SessionEvaluationSchema.safeParse(evaluation()).success).toBe(true);
    expect(
      SessionEvaluationSchema.safeParse(
        evaluation({ correctness: 0, clarity: 0, depth: 0 })
      ).success
    ).toBe(true);
    expect(
      SessionEvaluationSchema.safeParse(
        evaluation({ correctness: 10, clarity: 10, depth: 10 })
      ).success
    ).toBe(true);
  });

  it("rejects scores outside the band", () => {
    expect(SessionEvaluationSchema.safeParse(evaluation({ depth: 11 })).success).toBe(
      false
    );
    expect(SessionEvaluationSchema.safeParse(evaluation({ depth: -1 })).success).toBe(
      false
    );
  });

  // Scores from two different models are not strictly comparable, and without
  // this attribute that is invisible forever.
  it("requires the model that produced the score", () => {
    const { modelId: _dropped, ...withoutModel } = evaluation() as Record<
      string,
      unknown
    >;
    expect(SessionEvaluationSchema.safeParse(withoutModel).success).toBe(false);
  });

  it("requires a non-empty rationale", () => {
    expect(SessionEvaluationSchema.safeParse(evaluation({ rationale: "" })).success).toBe(
      false
    );
  });
});
