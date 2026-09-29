import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ITEM_TYPE, SORT_KEY, userPk } from "@repo/shared";
import { ProfileStateError, ServiceError } from "../../lib/errors";
import {
  claimInterviewSlot,
  recordSessionCreated,
  refundInterviewSlot,
  setAccessGrant,
} from "../../lib/profile";

// The quota's two writes. Both are UpdateItem with a ConditionExpression, and in
// both cases the EXPRESSION is the behaviour — so these tests assert on the command
// that was built, not only on what the function returned. A condition that is
// subtly wrong still returns true in a mock that resolves everything.
//
// Mocked at the client CLASS, so the module-level `dynamoClient` singleton in
// lib/dynamo.ts is intercepted through the prototype. No `mock.module` anywhere
// here: lib/profile is the subject, and stubbing an internal module would be the
// leak CLAUDE.md records from routes/plan.test.ts hijacking agents/planner.test.ts.

const dynamo = mockClient(DynamoDBDocumentClient);

const USER_ID = "sub-1";

const PROFILE = {
  type: ITEM_TYPE.USER_PROFILE,
  userId: USER_ID,
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  firstName: "Tharun",
  lastName: "Sekar",
  resumeKey: "resumes/sub-1/resume.pdf",
  resumeText: "redacted",
  repos: [],
  profileVersion: 3,
  sessionsStarted: 1,
  unlimitedAccess: false,
};

// Catch-all first, specific matcher second — reversed, the catch-all swallows
// everything. Recorded in CLAUDE.md as one of three non-obvious requirements for
// aws-sdk-client-mock under `bun test`.
beforeEach(() => {
  dynamo.reset();
  dynamo.on(UpdateCommand).resolves({ Attributes: PROFILE });
});

afterEach(() => {
  dynamo.reset();
});

function lastUpdate(): {
  UpdateExpression?: string;
  ConditionExpression?: string;
  ExpressionAttributeValues?: Record<string, unknown>;
  Key?: Record<string, unknown>;
} {
  const calls = dynamo.commandCalls(UpdateCommand);
  const input = calls[calls.length - 1]?.args[0]?.input;
  if (input === undefined) throw new Error("no UpdateCommand was sent");
  return input;
}

// The quota's two counters, which replaced a single atomic claim at session
// creation.
//
// That claim was the bug: it spent a slot when a session was MINTED, so pressing
// "Build my interview" and closing the tab cost an interview before the plan had
// rendered. The split is the fix — `recordSessionCreated` counts mints and meters
// nothing, `claimInterviewSlot` counts interviews actually conducted and is
// what the quota reads.
describe("recordSessionCreated", () => {
  it("adds to sessionsCreated and nothing else", async () => {
    await recordSessionCreated({ userId: USER_ID });

    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("ADD sessionsCreated :one");
    // The counter the quota reads must NOT move here. That is the whole point of
    // the split, so it is asserted as an absence rather than left implied.
    expect(input.UpdateExpression).not.toContain("sessionsConducted");
  });

  it("uses ADD, never a read-then-write", async () => {
    await recordSessionCreated({ userId: USER_ID });
    expect(lastUpdate().UpdateExpression).not.toContain("SET sessionsCreated");
  });

  it("refuses an account mid-erasure", async () => {
    await recordSessionCreated({ userId: USER_ID });
    expect(lastUpdate().ConditionExpression).toContain("#status <> :deleting");
  });

  it("swallows a mid-erasure refusal rather than throwing", async () => {
    dynamo.reset();
    dynamo
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "nope" }),
      );

    // Not an enforcement point. A wrong number in an admin column must never fail
    // the request that creates the session.
    expect(await recordSessionCreated({ userId: USER_ID })).toBeUndefined();
  });

  it("throws on a genuine write failure", async () => {
    dynamo.reset();
    dynamo
      .on(UpdateCommand)
      .rejects(new Error("ProvisionedThroughputExceeded"));

    expect(recordSessionCreated({ userId: USER_ID })).rejects.toThrow();
  });
});

function conditionalFailure(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ $metadata: {}, message: "no" });
}

function profileWith(fields: Record<string, unknown>) {
  return { Item: { ...PROFILE, ...fields } };
}

// THE quota enforcement point. Claimed when the Sonic stream opens, as a
// compare-and-swap on the counter.
//
// It replaced a charge on the first scoreable answer, with the limit checked only
// at session creation. That was a bypass: the check read a counter nothing had
// moved yet, so a candidate at 0/3 could mint fifty sessions and conduct them
// all, and an interview of nothing but "could you repeat that" was never charged.
describe("claimInterviewSlot", () => {
  it("grants a slot under the limit and increments the counter", async () => {
    dynamo.on(GetCommand).resolves(profileWith({ sessionsConducted: 1 }));

    const claim = await claimInterviewSlot({ userId: USER_ID });

    expect(claim.granted).toBe(true);
    expect(claim.allowance.used).toBe(2);
    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("ADD sessionsConducted :one");
  });

  it("conditions the write on the counter it read", async () => {
    dynamo.on(GetCommand).resolves(profileWith({ sessionsConducted: 2 }));

    await claimInterviewSlot({ userId: USER_ID });

    // The compare-and-swap. Without it two tabs reading 2/3 would both land and
    // the account would conduct four interviews on a limit of three.
    const input = lastUpdate();
    expect(input.ConditionExpression).toContain("sessionsConducted = :observed");
    expect(input.ExpressionAttributeValues?.[":observed"]).toBe(2);
    expect(input.ConditionExpression).toContain("#status <> :deleting");
  });

  it("refuses without writing when the quota is exhausted", async () => {
    dynamo.on(GetCommand).resolves(profileWith({ sessionsConducted: 3 }));

    const claim = await claimInterviewSlot({ userId: USER_ID });

    expect(claim.granted).toBe(false);
    expect(claim.allowance.exhausted).toBe(true);
    expect(dynamo.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("honours a numeric grant above the default", async () => {
    dynamo
      .on(GetCommand)
      .resolves(profileWith({ sessionsConducted: 3, sessionLimit: 10 }));

    expect((await claimInterviewSlot({ userId: USER_ID })).granted).toBe(true);
  });

  it("counts an unlimited account but guards nothing", async () => {
    dynamo
      .on(GetCommand)
      .resolves(profileWith({ sessionsConducted: 40, unlimitedAccess: true }));

    const claim = await claimInterviewSlot({ userId: USER_ID });

    expect(claim.granted).toBe(true);
    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("ADD sessionsConducted :one");
    expect(input.ConditionExpression).not.toContain(":observed");
  });

  it("re-reads after losing a race and refuses the loser at the limit", async () => {
    // Two tabs, one slot left. This call reads 2/3, loses the write to the other
    // tab, re-reads 3/3 and must be refused rather than retried blindly.
    dynamo
      .on(GetCommand)
      .resolvesOnce(profileWith({ sessionsConducted: 2 }))
      .resolves(profileWith({ sessionsConducted: 3 }));
    dynamo.on(UpdateCommand).rejectsOnce(conditionalFailure()).resolves({});

    const claim = await claimInterviewSlot({ userId: USER_ID });

    expect(claim.granted).toBe(false);
    expect(dynamo.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("closes the mint-many bypass: each claim sees the previous one", async () => {
    // The original exploit, replayed against the enforcement point. The counter
    // moves on every claim, so the fourth is refused no matter how many sessions
    // were minted while it read 0.
    let conducted = 0;
    dynamo
      .on(GetCommand)
      .callsFake(() => profileWith({ sessionsConducted: conducted }));
    dynamo.on(UpdateCommand).callsFake(() => {
      conducted += 1;
      return {};
    });

    const results: boolean[] = [];
    for (let i = 0; i < 5; i += 1) {
      results.push((await claimInterviewSlot({ userId: USER_ID })).granted);
    }

    expect(results).toEqual([true, true, true, false, false]);
  });

  it("refuses an account mid-erasure", async () => {
    dynamo.on(GetCommand).resolves(profileWith({ status: "deleting" }));

    expect(claimInterviewSlot({ userId: USER_ID })).rejects.toThrow(
      ProfileStateError,
    );
  });

  it("refuses when the profile is gone", async () => {
    dynamo.on(GetCommand).resolves({});

    expect(claimInterviewSlot({ userId: USER_ID })).rejects.toThrow(
      ProfileStateError,
    );
  });

  it("gives up with a service error after repeated contention", async () => {
    dynamo.on(GetCommand).resolves(profileWith({ sessionsConducted: 0 }));
    dynamo.on(UpdateCommand).rejects(conditionalFailure());

    expect(claimInterviewSlot({ userId: USER_ID })).rejects.toThrow(
      ServiceError,
    );
  });

  it("emits no doubled parentheses", async () => {
    // The regression from the condition-building bug that 500'd every interview
    // start. aws-sdk-client-mock does not parse expressions, so no fragment
    // assertion can catch it.
    dynamo.on(GetCommand).resolves(profileWith({ sessionsConducted: 0 }));

    await claimInterviewSlot({ userId: USER_ID });

    const expression = lastUpdate().ConditionExpression ?? "";
    expect(expression).not.toContain("((");
    expect(expression).not.toContain("))");
  });
});

describe("refundInterviewSlot", () => {
  it("decrements the counter, floored at zero by the condition", async () => {
    await refundInterviewSlot({ userId: USER_ID });

    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("ADD sessionsConducted :minusOne");
    expect(input.ExpressionAttributeValues?.[":minusOne"]).toBe(-1);
    expect(input.ConditionExpression).toContain("sessionsConducted > :zero");
  });

  it("returns true when the refund landed", async () => {
    expect(await refundInterviewSlot({ userId: USER_ID })).toBe(true);
  });

  it("returns false rather than throwing when the condition fails", async () => {
    dynamo.reset();
    dynamo.on(UpdateCommand).rejects(conditionalFailure());

    expect(await refundInterviewSlot({ userId: USER_ID })).toBe(false);
  });

  it("throws on a genuine write failure", async () => {
    dynamo.reset();
    dynamo.on(UpdateCommand).rejects(new Error("ResourceNotFoundException"));

    expect(refundInterviewSlot({ userId: USER_ID })).rejects.toThrow();
  });
});

describe("setAccessGrant", () => {
  it("sets the flag and the number when a numeric grant is given", async () => {
    await setAccessGrant({
      userId: USER_ID,
      unlimitedAccess: false,
      sessionLimit: 10,
    });

    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("sessionLimit = :limit");
    expect(input.ExpressionAttributeValues?.[":limit"]).toBe(10);
    expect(input.ExpressionAttributeValues?.[":unlimited"]).toBe(false);
  });

  it("REMOVES sessionLimit when no number is given", async () => {
    // What makes "reset to the default" expressible at all. Without the REMOVE,
    // lowering someone from 50 back to normal would mean typing 3 — pinning a
    // number that stops tracking the default if it ever changes.
    await setAccessGrant({
      userId: USER_ID,
      unlimitedAccess: false,
      sessionLimit: undefined,
    });

    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("REMOVE sessionLimit");
    expect(input.ExpressionAttributeValues?.[":limit"]).toBeUndefined();
  });

  it("never touches profileVersion", async () => {
    // A quota grant changes nothing the Planner reads. Bumping the version would
    // discard a good cached plan and buy a Bedrock call for an administrative act.
    await setAccessGrant({
      userId: USER_ID,
      unlimitedAccess: true,
      sessionLimit: undefined,
    });

    expect(lastUpdate().UpdateExpression).not.toContain("profileVersion");
  });

  it("never touches sessionsStarted", async () => {
    // Granting access must not reset usage. If it did, every grant would silently
    // hand back the interviews already taken and the counter would stop meaning
    // anything.
    await setAccessGrant({
      userId: USER_ID,
      unlimitedAccess: true,
      sessionLimit: 5,
    });

    expect(lastUpdate().UpdateExpression).not.toContain("sessionsStarted");
  });

  it("requires the profile to exist rather than upserting one", async () => {
    // An upsert here would create a PROFILE item holding nothing but a quota —
    // which fails UserProfileSchema on the next read (no userId, no status, no
    // timestamps) and makes an un-onboarded account look onboarded in the table.
    await setAccessGrant({
      userId: USER_ID,
      unlimitedAccess: true,
      sessionLimit: undefined,
    });

    expect(lastUpdate().ConditionExpression).toContain("attribute_exists(PK)");
  });

  it("returns null when there is no profile to grant against", async () => {
    dynamo.reset();
    dynamo
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "nope" }),
      );

    // Null rather than a throw, so the route can answer 409 with copy that says
    // "that account exists but has not onboarded" instead of a generic failure.
    expect(
      await setAccessGrant({
        userId: USER_ID,
        unlimitedAccess: true,
        sessionLimit: undefined,
      }),
    ).toBeNull();
  });

  it("throws on a genuine write failure", async () => {
    dynamo.reset();
    dynamo.on(UpdateCommand).rejects(new Error("ResourceNotFoundException"));

    expect(
      setAccessGrant({
        userId: USER_ID,
        unlimitedAccess: true,
        sessionLimit: undefined,
      }),
    ).rejects.toThrow();
  });
});
