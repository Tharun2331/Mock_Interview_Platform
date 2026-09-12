import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  ITEM_TYPE,
  KEY_PREFIX,
  SORT_KEY,
  extremeDimensions,
  overallScore,
  sessionPk,
  userPk,
  userSummarySk,
} from "@repo/shared";
import {
  deleteSessionSummaries,
  listSessionHistory,
} from "../../lib/evaluations";

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = "prepilot-sessions-test";
const USER_ID = "user-1";

function summaryRow(overrides: Record<string, unknown> = {}) {
  const completedAt = "2026-09-12T10:00:00.000Z";
  return {
    PK: userPk(USER_ID),
    SK: userSummarySk(completedAt),
    type: ITEM_TYPE.USER_SESSION_SUMMARY,
    sessionId: "01J000000000000000000001",
    completedAt,
    role: "Backend Engineer",
    overallScore: 6.4,
    topStrength: "depth",
    topWeakness: "clarity",
    questionCount: 6,
    ...overrides,
  };
}

beforeEach(() => {
  ddb.reset();
  ddb.on(BatchWriteCommand).resolves({});
});
afterAll(() => ddb.restore());

// The whole reason the timestamp is in the sort key rather than an attribute.
describe("the history key layout", () => {
  it("orders chronologically because ISO sorts lexicographically", () => {
    const keys = [
      userSummarySk("2026-09-12T10:00:00.000Z"),
      userSummarySk("2026-01-02T09:00:00.000Z"),
      userSummarySk("2026-09-12T09:59:59.000Z"),
    ];

    expect([...keys].sort()).toEqual([
      userSummarySk("2026-01-02T09:00:00.000Z"),
      userSummarySk("2026-09-12T09:59:59.000Z"),
      userSummarySk("2026-09-12T10:00:00.000Z"),
    ]);
  });

  // The USER partition also holds PROFILE, PLAN and every SESSION# ref. These
  // two prefixes must not see each other: the erasure sweep finds sessions with
  // begins_with("SESSION#"), and this query must not pick those up.
  it("cannot be confused with a session ref by either query", () => {
    const summary = userSummarySk("2026-09-12T10:00:00.000Z");

    expect(summary.startsWith(KEY_PREFIX.SESSION)).toBe(false);
    expect(`${KEY_PREFIX.SESSION}01J`.startsWith(KEY_PREFIX.USER_SUMMARY)).toBe(
      false
    );
    // And it sorts after the refs, so neither Query's range touches the other.
    expect(summary > `${KEY_PREFIX.SESSION}￿`).toBe(true);
  });

  // NOT the per-session rollup at SESSION#<sid>/SUMMARY. Different partition,
  // different purpose — one is the scoring denominator, this is a history card.
  it("is a different key from the per-session rollup", () => {
    expect(SORT_KEY.EVAL_SUMMARY).toBe("SUMMARY");
    expect(userSummarySk("2026-09-12T10:00:00.000Z")).not.toBe(
      SORT_KEY.EVAL_SUMMARY
    );
  });
});

describe("listSessionHistory", () => {
  it("queries the candidate's own partition, newest first", async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryRow()] });

    await listSessionHistory({ userId: USER_ID });

    const input = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.ExpressionAttributeValues?.[":pk"]).toBe(userPk(USER_ID));
    expect(input?.ExpressionAttributeValues?.[":prefix"]).toBe(
      KEY_PREFIX.USER_SUMMARY
    );
    // Reversing the scan is the whole of the ordering logic.
    expect(input?.ScanIndexForward).toBe(false);
  });

  it("returns one card per finished interview", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        summaryRow({ sessionId: "s2", completedAt: "2026-09-12T10:00:00.000Z" }),
        summaryRow({ sessionId: "s1", completedAt: "2026-09-11T10:00:00.000Z" }),
      ],
    });

    const history = await listSessionHistory({ userId: USER_ID });

    expect(history.map((item) => item.sessionId)).toEqual(["s2", "s1"]);
    expect(history[0]?.overallScore).toBe(6.4);
    expect(history[0]?.role).toBe("Backend Engineer");
  });

  // The card list must stay small. Transcripts, per-question scores and
  // rationales live on the session's own items and are fetched only when a card
  // is clicked.
  it("carries nothing heavy", async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryRow()] });

    const [card] = await listSessionHistory({ userId: USER_ID });

    expect(card).not.toHaveProperty("evaluations");
    expect(card).not.toHaveProperty("transcript");
    expect(card).not.toHaveProperty("rationale");
    expect(card).not.toHaveProperty("expiresAt");
  });

  // One unreadable card costs a candidate one row of history; an exception
  // costs them all of it.
  it("skips a row that no longer matches its schema", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [summaryRow(), summaryRow({ overallScore: "six point four" })],
    });

    expect(await listSessionHistory({ userId: USER_ID })).toHaveLength(1);
  });

  it("follows pagination", async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [summaryRow({ sessionId: "s3" })],
        LastEvaluatedKey: { PK: userPk(USER_ID), SK: "SUMMARY#x" },
      })
      .resolvesOnce({ Items: [summaryRow({ sessionId: "s2" })] });

    expect(await listSessionHistory({ userId: USER_ID })).toHaveLength(2);
  });

  it("returns an empty list for a candidate with no finished interviews", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    expect(await listSessionHistory({ userId: USER_ID })).toEqual([]);
  });
});

// These rows live in the USER partition, so deleteSessionData never sees them
// and neither does deleteUserSessionRefs. Left behind they are rows keyed to a
// deleted user — the thing erasure exists to prevent.
describe("deleteSessionSummaries", () => {
  it("removes every history card a candidate has", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        { PK: userPk(USER_ID), SK: "SUMMARY#2026-09-12T10:00:00.000Z" },
        { PK: userPk(USER_ID), SK: "SUMMARY#2026-09-11T10:00:00.000Z" },
      ],
    });

    expect(await deleteSessionSummaries({ userId: USER_ID })).toBe(2);
  });

  it("reads keys only", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    await deleteSessionSummaries({ userId: USER_ID });

    expect(
      ddb.commandCalls(QueryCommand)[0]?.args[0].input.ProjectionExpression
    ).toBe("PK, SK");
  });

  it("does nothing for a candidate with no history", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    expect(await deleteSessionSummaries({ userId: USER_ID })).toBe(0);
  });
});

// Derived rather than stored per-dimension, so the card stays one row.
describe("overallScore", () => {
  it("is the mean of the three dimensions, to one decimal", () => {
    expect(overallScore({ correctness: 6, clarity: 7, depth: 5 })).toBe(6);
    expect(overallScore({ correctness: 7, clarity: 6, depth: 5 })).toBe(6);
    expect(overallScore({ correctness: 6, clarity: 6, depth: 7 })).toBeCloseTo(6.3, 5);
  });

  it("stays inside the 0-10 band at both ends", () => {
    expect(overallScore({ correctness: 0, clarity: 0, depth: 0 })).toBe(0);
    expect(overallScore({ correctness: 10, clarity: 10, depth: 10 })).toBe(10);
  });
});

describe("extremeDimensions", () => {
  it("names the highest and lowest scoring dimension", () => {
    expect(extremeDimensions({ correctness: 4, clarity: 8, depth: 6 })).toEqual({
      topStrength: "clarity",
      topWeakness: "correctness",
    });
  });

  // Picking max and min independently would name the SAME dimension as both
  // strength and weakness on a flat profile, which reads as a bug.
  it("never names one dimension as both on a flat profile", () => {
    const result = extremeDimensions({ correctness: 5, clarity: 5, depth: 5 });

    expect(result.topStrength).not.toBe(result.topWeakness);
  });

  it("resolves a two-way tie without collapsing", () => {
    const result = extremeDimensions({ correctness: 7, clarity: 7, depth: 2 });

    expect(result.topWeakness).toBe("depth");
    expect(result.topStrength).not.toBe(result.topWeakness);
  });
});

// Written at finalisation, by the one worker that won the election — so there
// is one row per session rather than one per evaluation.
describe("the summary write", () => {
  it("is keyed to the candidate, not the session", async () => {
    // Exercised through the finalisation path in worker.test.ts; this pins the
    // key shape the history query depends on.
    const completedAt = "2026-09-12T10:00:00.000Z";
    expect(userPk(USER_ID)).toBe("USER#user-1");
    expect(userSummarySk(completedAt)).toBe(`SUMMARY#${completedAt}`);
    expect(sessionPk("s1")).toBe("SESSION#s1");
  });
});
