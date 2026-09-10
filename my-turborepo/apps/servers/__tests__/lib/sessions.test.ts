import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  ITEM_TYPE,
  PLAN_LIMITS,
  SORT_KEY,
  sessionPk,
  sessionSk,
  userPk,
} from "@repo/shared";
import { SECONDS_PER_DAY, SESSION_RETENTION } from "../../lib/constants";
import { ServiceError, SessionAccessError, SessionStateError } from "../../lib/errors";
import { MESSAGES } from "../../lib/messages";
import {
  attachPlan,
  createSession,
  deleteSessionData,
  deleteUserSessionRefs,
  finishInterview,
  listUserSessionIds,
  loadPlannerInputs,
  recordAnswer,
  sessionExpiresAt,
  startInterview,
} from "../../lib/sessions";

// The session lifecycle. Everything the Evaluator will read in Phase 5 is
// written by this module, so its key layout and its conditional writes are the
// contract that phase is built on.

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = "prepilot-sessions-test";
const SESSION_ID = "01J000000000000000000000";
const USER_ID = "user-1";
const NOW = "2026-09-09T12:00:00.000Z";

const PLAN = {
  focusAreas: [
    { area: "Kafka", evidence: "order-service", source: "github" as const },
    { area: "Postgres", evidence: "order-service", source: "github" as const },
  ],
  questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
  startingDifficulty: "mid" as const,
  targetMinutes: 30,
  reasoning: "why",
};

function conditionalFailure(item?: Record<string, unknown>) {
  const error = new ConditionalCheckFailedException({
    $metadata: {},
    message: "The conditional request failed",
  });
  if (item !== undefined) {
    Object.assign(error, { Item: item });
  }
  return error;
}

beforeEach(() => ddb.reset());
afterAll(() => ddb.restore());

// One value shared by every item in a session. Derived per-item from "now"
// instead, a session written across an hour would have its parts disappear
// across an hour — leaving a transcript whose META is already gone.
describe("sessionExpiresAt", () => {
  it("is now plus the retention window, in epoch seconds", () => {
    const before = Math.floor(Date.now() / 1000);
    const value = sessionExpiresAt();
    const after = Math.floor(Date.now() / 1000);

    const window = SESSION_RETENTION.DAYS * SECONDS_PER_DAY;
    expect(value).toBeGreaterThanOrEqual(before + window);
    expect(value).toBeLessThanOrEqual(after + window);
  });

  it("is seconds, not milliseconds — DynamoDB TTL reads epoch seconds", () => {
    // A milliseconds value would be ~1000x larger and sit far in the future,
    // which TTL silently never acts on.
    expect(sessionExpiresAt()).toBeLessThan(Date.now());
  });
});

describe("createSession", () => {
  const ARGS = {
    sessionId: SESSION_ID,
    userId: USER_ID,
    resumeKey: "resumes/user-1/resume.pdf",
    githubUsername: "Tharun2331",
    repos: [{ description: null, name: "a", fullName: "u/a", starCount: 1 }],
    resumeText: "redacted text",
    profileVersion: 3,
  };

  function transactItems() {
    const input = ddb.commandCalls(TransactWriteCommand)[0]?.args[0].input;
    return input?.TransactItems ?? [];
  }

  it("writes META, INPUTS and the user ref in one transaction", async () => {
    ddb.on(TransactWriteCommand).resolves({});

    await createSession(ARGS);

    // One transaction, not three writes: a history entry pointing at a META
    // item that was never written is a row that 404s when clicked.
    expect(ddb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(transactItems()).toHaveLength(3);
  });

  it("gives every item in the session the same expiry", async () => {
    ddb.on(TransactWriteCommand).resolves({});

    await createSession(ARGS);

    const expiries = transactItems().map((item) => item.Put?.Item?.expiresAt);
    expect(expiries).toHaveLength(3);
    expect(new Set(expiries).size).toBe(1);
    expect(expiries[0]).toBeGreaterThan(0);
  });

  it("keys the three items as the data model specifies", async () => {
    ddb.on(TransactWriteCommand).resolves({});

    await createSession(ARGS);

    const keys = transactItems().map((item) => ({
      PK: item.Put?.Item?.PK,
      SK: item.Put?.Item?.SK,
    }));

    expect(keys).toEqual([
      { PK: sessionPk(SESSION_ID), SK: SORT_KEY.META },
      { PK: sessionPk(SESSION_ID), SK: SORT_KEY.INPUTS },
      // The lookup item that makes history a base-table Query, in the USER
      // partition rather than the session's.
      { PK: userPk(USER_ID), SK: sessionSk(SESSION_ID) },
    ]);
  });

  // ULID collision is not realistic, but a silent overwrite of somebody's
  // session is bad enough to be worth one condition expression.
  it("refuses to overwrite an existing session", async () => {
    ddb.on(TransactWriteCommand).resolves({});

    await createSession(ARGS);

    expect(transactItems()[0]?.Put?.ConditionExpression).toBe(
      "attribute_not_exists(PK)"
    );
  });

  // removeUndefinedValues strips it, so an omitted profile leaves the attribute
  // absent rather than present-and-null.
  it("omits githubUsername entirely when there is none", async () => {
    ddb.on(TransactWriteCommand).resolves({});

    await createSession({ ...ARGS, githubUsername: null });

    expect(transactItems()[0]?.Put?.Item?.githubUsername).toBeUndefined();
  });

  it("stamps the profile version the INPUTS snapshot was copied from", async () => {
    ddb.on(TransactWriteCommand).resolves({});

    await createSession(ARGS);

    expect(transactItems()[0]?.Put?.Item?.profileVersion).toBe(3);
  });

  // Both bounds come from the schema the item is validated against on read, so
  // a stored item can never be too large for its own validator.
  it("caps repos and resume text on the way in", async () => {
    ddb.on(TransactWriteCommand).resolves({});
    const repo = { description: null, name: "x", fullName: "u/x", starCount: 0 };

    await createSession({
      ...ARGS,
      repos: Array(PLAN_LIMITS.MAX_REPOS + 10).fill(repo),
      resumeText: "a".repeat(PLAN_LIMITS.MAX_RESUME_CHARS + 500),
    });

    const inputs = transactItems()[1]?.Put?.Item;
    expect(inputs?.repos).toHaveLength(PLAN_LIMITS.MAX_REPOS);
    expect(inputs?.resumeText).toHaveLength(PLAN_LIMITS.MAX_RESUME_CHARS);
  });

  it("surfaces the cancellation reasons when the transaction is cancelled", async () => {
    const cancelled = new TransactionCanceledException({
      $metadata: {},
      message: "cancelled",
    });
    Object.assign(cancelled, {
      CancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }],
    });
    ddb.on(TransactWriteCommand).rejects(cancelled);

    // The reasons are what say *which* of the three writes failed.
    await expect(createSession(ARGS)).rejects.toThrow(ServiceError);
    await expect(createSession(ARGS)).rejects.toThrow(/ConditionalCheckFailed/);
  });

  it("wraps any other failure as a ServiceError", async () => {
    ddb.on(TransactWriteCommand).rejects(new Error("throughput exceeded"));

    await expect(createSession(ARGS)).rejects.toThrow(ServiceError);
  });
});

describe("listUserSessionIds", () => {
  // The USER partition also holds PROFILE and PLAN, both of which sort before
  // "SESSION#". An unfiltered Query would return them and this would try to
  // delete a session whose id is undefined.
  it("filters to the SESSION# prefix rather than reading the partition", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });

    await listUserSessionIds({ userId: USER_ID });

    const input = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.KeyConditionExpression).toBe(
      "PK = :pk AND begins_with(SK, :prefix)"
    );
    expect(input?.ExpressionAttributeValues?.[":prefix"]).toBe("SESSION#");
    // Only the id is needed; projecting the whole ref reads attributes this
    // never looks at, on every page.
    expect(input?.ProjectionExpression).toBe("sessionId");
  });

  // A candidate with enough history to exceed 1 MB of refs is exactly the one
  // whose leftovers would go unnoticed.
  it("follows pagination to the end", async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ sessionId: "s1" }, { sessionId: "s2" }],
        LastEvaluatedKey: { PK: userPk(USER_ID), SK: "SESSION#s2" },
      })
      .resolvesOnce({ Items: [{ sessionId: "s3" }] });

    const ids = await listUserSessionIds({ userId: USER_ID });

    expect(ids).toEqual(["s1", "s2", "s3"]);
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it("skips rows whose sessionId is not a string", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [{ sessionId: "s1" }, { sessionId: undefined }, { other: "x" }],
    });

    expect(await listUserSessionIds({ userId: USER_ID })).toEqual(["s1"]);
  });

  it("wraps a read failure as a ServiceError", async () => {
    ddb.on(QueryCommand).rejects(new Error("throttled"));

    await expect(listUserSessionIds({ userId: USER_ID })).rejects.toThrow(
      ServiceError
    );
  });
});

describe("deleteSessionData", () => {
  function keys(count: number) {
    return Array.from({ length: count }, (_unused, index) => ({
      PK: sessionPk(SESSION_ID),
      SK: `ANSWER#q${index}`,
    }));
  }

  it("reads keys only — a transcript can be large and none of it is used", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(BatchWriteCommand).resolves({});

    await deleteSessionData({ sessionId: SESSION_ID });

    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input.ProjectionExpression)
      .toBe("PK, SK");
  });

  // BatchWriteItem caps at 25. Sending 26 is a validation error, not a slower
  // request.
  it("chunks deletes at the BatchWriteItem cap", async () => {
    ddb.on(QueryCommand).resolves({ Items: keys(60) });
    ddb.on(BatchWriteCommand).resolves({});

    const deleted = await deleteSessionData({ sessionId: SESSION_ID });

    expect(deleted).toBe(60);
    // 25 + 25 + 10
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(3);
    for (const call of ddb.commandCalls(BatchWriteCommand)) {
      const batch = call.args[0].input.RequestItems?.[TABLE] ?? [];
      expect(batch.length).toBeLessThanOrEqual(25);
    }
  });

  it("deletes across query pages", async () => {
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: keys(3), LastEvaluatedKey: { PK: "x", SK: "y" } })
      .resolvesOnce({ Items: keys(2) });
    ddb.on(BatchWriteCommand).resolves({});

    expect(await deleteSessionData({ sessionId: SESSION_ID })).toBe(5);
  });

  // BatchWriteItem reports per-item throttling as UnprocessedItems rather than
  // an error, so a batch can "succeed" having written nothing.
  it("retries unprocessed items rather than reporting a false success", async () => {
    ddb.on(QueryCommand).resolves({ Items: keys(2) });
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: {
          [TABLE]: [{ DeleteRequest: { Key: { PK: "p", SK: "s" } } }],
        },
      })
      .resolvesOnce({});

    await deleteSessionData({ sessionId: SESSION_ID });

    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  // Throwing leaves the profile's `deleting` marker in place, which is what
  // makes the sweep resumable.
  it("gives up after three attempts and says the delete was incomplete", async () => {
    ddb.on(QueryCommand).resolves({ Items: keys(1) });
    ddb.on(BatchWriteCommand).resolves({
      UnprocessedItems: {
        [TABLE]: [{ DeleteRequest: { Key: { PK: "p", SK: "s" } } }],
      },
    });

    await expect(deleteSessionData({ sessionId: SESSION_ID })).rejects.toThrow(
      MESSAGES.SESSION_DELETE_INCOMPLETE
    );
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(3);
  });
});

// These refs live in the USER partition, not the session's, so
// deleteSessionData never sees them. Left behind, they are rows keyed to a
// deleted user — exactly what erasure was supposed to prevent.
describe("deleteUserSessionRefs", () => {
  it("deletes a ref for every session id, in the user's partition", async () => {
    ddb.on(BatchWriteCommand).resolves({});

    const count = await deleteUserSessionRefs({
      userId: USER_ID,
      sessionIds: ["s1", "s2"],
    });

    expect(count).toBe(2);
    const batch =
      ddb.commandCalls(BatchWriteCommand)[0]?.args[0].input.RequestItems?.[TABLE] ??
      [];
    expect(batch.map((request) => request.DeleteRequest?.Key)).toEqual([
      { PK: userPk(USER_ID), SK: "SESSION#s1" },
      { PK: userPk(USER_ID), SK: "SESSION#s2" },
    ]);
  });

  it("chunks at the same cap", async () => {
    ddb.on(BatchWriteCommand).resolves({});
    const ids = Array.from({ length: 30 }, (_unused, i) => `s${i}`);

    expect(await deleteUserSessionRefs({ userId: USER_ID, sessionIds: ids })).toBe(30);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it("does nothing for a candidate with no sessions", async () => {
    ddb.on(BatchWriteCommand).resolves({});

    expect(await deleteUserSessionRefs({ userId: USER_ID, sessionIds: [] })).toBe(0);
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });
});

describe("loadPlannerInputs", () => {
  const META = {
    PK: sessionPk(SESSION_ID),
    SK: SORT_KEY.META,
    type: ITEM_TYPE.SESSION_META,
    sessionId: SESSION_ID,
    userId: USER_ID,
    status: "planning",
    createdAt: NOW,
    profileVersion: 3,
  };

  const INPUTS = {
    PK: sessionPk(SESSION_ID),
    SK: SORT_KEY.INPUTS,
    type: ITEM_TYPE.SESSION_INPUTS,
    repos: [{ description: null, name: "a", fullName: "u/a", starCount: 1 }],
    resumeText: "redacted text",
    resumeKey: "resumes/user-1/resume.pdf",
  };

  function respond(items: Record<string, unknown>[]) {
    ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: items } });
  }

  it("returns the material and the version it was snapshotted at", async () => {
    respond([META, INPUTS]);

    const result = await loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID });

    expect(result.repos).toEqual(INPUTS.repos);
    expect(result.resumeText).toBe("redacted text");
    expect(result.profileVersion).toBe(3);
  });

  // BatchGetItem returns matches unordered and simply omits misses, so the
  // items must be found by sort key rather than by position.
  it("finds each item by sort key, not by position", async () => {
    respond([INPUTS, META]);

    const result = await loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID });

    expect(result.resumeText).toBe("redacted text");
    expect(result.profileVersion).toBe(3);
  });

  it("reads strongly consistent", async () => {
    respond([META, INPUTS]);

    await loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID });

    const input = ddb.commandCalls(BatchGetCommand)[0]?.args[0].input;
    expect(input?.RequestItems?.[TABLE]?.ConsistentRead).toBe(true);
  });

  // An empty extraction is a real outcome — a scanned resume — and the Planner
  // treats absent and empty the same way.
  it("reports an empty resume as absent rather than as an empty string", async () => {
    respond([META, { ...INPUTS, resumeText: "" }]);

    const result = await loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID });

    expect(result.resumeText).toBeUndefined();
  });

  // Same error for "no such session" and "not yours": the response must not
  // confirm that a session id exists.
  it("refuses a session belonging to someone else", async () => {
    respond([{ ...META, userId: "someone-else" }, INPUTS]);

    await expect(
      loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID })
    ).rejects.toThrow(SessionAccessError);
  });

  it("gives a missing session the same error as one that is not yours", async () => {
    respond([]);

    await expect(
      loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID })
    ).rejects.toThrow(MESSAGES.SESSION_NOT_FOUND);
  });

  // Re-planning would swap the focus areas out from under a session that has
  // answers recorded against the old ones.
  it.each(["in_progress", "evaluating", "complete", "failed"] as const)(
    "refuses to replan a session that is %s",
    async (status) => {
      respond([{ ...META, status }, INPUTS]);

      await expect(
        loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID })
      ).rejects.toThrow(SessionStateError);
    }
  );

  it.each(["planning", "ready"] as const)("allows replanning while %s", async (status) => {
    respond([{ ...META, status }, INPUTS]);

    await expect(
      loadPlannerInputs({ sessionId: SESSION_ID, userId: USER_ID })
    ).resolves.toBeDefined();
  });
});

describe("recordAnswer", () => {
  const ARGS = {
    sessionId: SESSION_ID,
    questionId: "q1",
    questionText: "Tell me about the pipeline.",
    questionType: "technical" as const,
    transcript: "We used Kafka.",
    askedAt: NOW,
    durationMs: 42_000,
    interrupted: false,
  };

  // Keyed by questionId and conditioned on nothing: a late or duplicate write
  // is far better than a lost answer, and a retry overwrites rather than
  // duplicating.
  it("writes an idempotent item keyed by question id", async () => {
    ddb.on(PutCommand).resolves({});

    await recordAnswer(ARGS);

    const input = ddb.commandCalls(PutCommand)[0]?.args[0].input;
    expect(input?.Item?.PK).toBe(sessionPk(SESSION_ID));
    expect(input?.Item?.SK).toBe("ANSWER#q1");
    expect(input?.ConditionExpression).toBeUndefined();
  });

  it("carries a TTL so the answer expires with its session", async () => {
    ddb.on(PutCommand).resolves({});

    await recordAnswer(ARGS);

    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item?.expiresAt)
      .toBeGreaterThan(0);
  });

  // Nullable, not absent: "we tried and there is none" is a real state the
  // Evaluator can encounter.
  it("writes audioKey as null rather than omitting it", async () => {
    ddb.on(PutCommand).resolves({});

    await recordAnswer(ARGS);

    expect(ddb.commandCalls(PutCommand)[0]?.args[0].input.Item?.audioKey).toBeNull();
  });
});

describe("finishInterview", () => {
  // Only from in_progress, so a late close cannot drag a session that has
  // already moved on to evaluating back to complete.
  it("only moves a session that is still in progress", async () => {
    ddb.on(UpdateCommand).resolves({});

    await finishInterview({ sessionId: SESSION_ID, status: "complete" });

    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("#status = :inProgress");
    expect(input?.ExpressionAttributeValues?.[":status"]).toBe("complete");
  });

  it("can mark a session failed", async () => {
    ddb.on(UpdateCommand).resolves({});

    await finishInterview({ sessionId: SESSION_ID, status: "failed" });

    expect(
      ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues?.[
        ":status"
      ]
    ).toBe("failed");
  });

  // The normal outcome once answers exist: they are recorded but nothing has
  // scored them. Marking such a session complete would tell the results page
  // feedback is ready while the queue is still full, with no later transition
  // to correct it.
  it("can park a session at evaluating while its answers are scored", async () => {
    ddb.on(UpdateCommand).resolves({});

    await finishInterview({ sessionId: SESSION_ID, status: "evaluating" });

    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ExpressionAttributeValues?.[":status"]).toBe("evaluating");
    // Still only from in_progress — the guard does not loosen just because
    // there is a third destination.
    expect(input?.ConditionExpression).toBe("#status = :inProgress");
  });
});

describe("startInterview", () => {
  const READY_META = {
    type: ITEM_TYPE.SESSION_META,
    sessionId: SESSION_ID,
    userId: USER_ID,
    status: "in_progress",
    createdAt: NOW,
    plan: PLAN,
    questionCount: 10,
  };

  // The conditional update is what stops two browser tabs opening two Sonic
  // streams against one session — which would bill twice and interleave two
  // conversations into one transcript.
  it("moves ready to in_progress atomically, scoped to the owner", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: READY_META });

    await startInterview({ sessionId: SESSION_ID, userId: USER_ID });

    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe(
      "attribute_exists(PK) AND userId = :userId AND #status = :ready"
    );
    // The whole item comes back so the caller gets the plan without a second
    // read — it is needed immediately to build the system prompt.
    expect(input?.ReturnValues).toBe("ALL_NEW");
  });

  it("returns the parsed meta including the plan", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: READY_META });

    const meta = await startInterview({ sessionId: SESSION_ID, userId: USER_ID });

    expect(meta.status).toBe("in_progress");
    expect(meta.plan?.targetMinutes).toBe(30);
  });

  // Ownership proven, so the message can say what actually happened.
  it("tells the owner their session is not interviewable", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure({ userId: { S: USER_ID } }));

    await expect(
      startInterview({ sessionId: SESSION_ID, userId: USER_ID })
    ).rejects.toThrow(MESSAGES.SESSION_NOT_INTERVIEWABLE);
  });

  // Someone else's session and a missing one stay indistinguishable.
  it("gives a non-owner the same answer as for a missing session", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure({ userId: { S: "someone-else" } }));

    await expect(
      startInterview({ sessionId: SESSION_ID, userId: USER_ID })
    ).rejects.toThrow(SessionAccessError);
  });

  it("treats an absent item on the failure the same way", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure());

    await expect(
      startInterview({ sessionId: SESSION_ID, userId: USER_ID })
    ).rejects.toThrow(MESSAGES.SESSION_NOT_FOUND);
  });
});

describe("attachPlan", () => {
  const ARGS = {
    sessionId: SESSION_ID,
    userId: USER_ID,
    targetRole: "Backend Engineer",
    plan: PLAN,
  };

  // questionCount is the denominator the Evaluator uses to decide the interview
  // is complete, so a wrong value fires the Coach early or never.
  it("derives questionCount from the mix rather than trusting a caller", async () => {
    ddb.on(UpdateCommand).resolves({});

    await attachPlan(ARGS);

    const values =
      ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues;
    expect(values?.[":questionCount"]).toBe(10);
  });

  // Without `userId = :userId` any authenticated caller could write a plan into
  // any session id they guessed.
  it("conditions the write on ownership and a replannable status", async () => {
    ddb.on(UpdateCommand).resolves({});

    await attachPlan(ARGS);

    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ConditionExpression)
      .toBe(
        "attribute_exists(PK) AND userId = :userId AND #status IN (:planning, :ready)"
      );
  });

  it("moves the session to ready and records the role", async () => {
    ddb.on(UpdateCommand).resolves({});

    await attachPlan(ARGS);

    const values =
      ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues;
    expect(values?.[":status"]).toBe("ready");
    expect(values?.[":role"]).toBe("Backend Engineer");
  });

  // plan, role and status are all DynamoDB reserved words.
  it("aliases every reserved word it writes", async () => {
    ddb.on(UpdateCommand).resolves({});

    await attachPlan(ARGS);

    expect(ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeNames)
      .toEqual({ "#plan": "plan", "#role": "role", "#status": "status" });
  });

  // The interview started while the Planner was running — a window of several
  // seconds that only the condition expression closes.
  it("tells the owner the interview already started", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure({ userId: { S: USER_ID } }));

    await expect(attachPlan(ARGS)).rejects.toThrow(MESSAGES.SESSION_ALREADY_STARTED);
  });

  it("does not confirm that someone else's session id exists", async () => {
    ddb.on(UpdateCommand).rejects(conditionalFailure({ userId: { S: "someone-else" } }));

    await expect(attachPlan(ARGS)).rejects.toThrow(SessionAccessError);
    await expect(attachPlan(ARGS)).rejects.toThrow(MESSAGES.SESSION_NOT_FOUND);
  });

  it("wraps an unrelated failure as a ServiceError", async () => {
    ddb.on(UpdateCommand).rejects(new Error("throughput exceeded"));

    await expect(attachPlan(ARGS)).rejects.toThrow(ServiceError);
  });
});
