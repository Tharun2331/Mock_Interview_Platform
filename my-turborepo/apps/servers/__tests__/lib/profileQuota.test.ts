import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ITEM_TYPE, SORT_KEY, userPk } from "@repo/shared";
import {
  chargeConductedSession,
  recordSessionCreated,
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
// nothing, `chargeConductedSession` counts interviews actually conducted and is
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

describe("chargeConductedSession", () => {
  it("adds to sessionsConducted, which is what the quota reads", async () => {
    await chargeConductedSession({ userId: USER_ID });

    const input = lastUpdate();
    expect(input.UpdateExpression).toContain("ADD sessionsConducted :one");
    expect(input.UpdateExpression).not.toContain("sessionsCreated");
  });

  it("uses ADD so two answers landing together cannot lose a count", async () => {
    await chargeConductedSession({ userId: USER_ID });
    expect(lastUpdate().UpdateExpression).not.toContain(
      "SET sessionsConducted",
    );
  });

  it("attaches NO cap condition", async () => {
    // The limit was checked before the interview started. Re-checking here would
    // refuse to record an interview that has already happened, which loses the
    // count without giving anyone their time back.
    await chargeConductedSession({ userId: USER_ID });

    const expression = lastUpdate().ConditionExpression ?? "";
    expect(expression).not.toContain("sessionsConducted <");
    expect(expression).not.toContain(":limit");
  });

  it("does not charge an account mid-erasure", async () => {
    dynamo.reset();
    dynamo
      .on(UpdateCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "nope" }),
      );

    // Its quota is about to stop existing. Swallowed rather than thrown, because
    // the interview it would be charging for has already happened.
    expect(await chargeConductedSession({ userId: USER_ID })).toBeUndefined();
  });

  it("throws on a genuine write failure", async () => {
    dynamo.reset();
    dynamo.on(UpdateCommand).rejects(new Error("ResourceNotFoundException"));

    expect(chargeConductedSession({ userId: USER_ID })).rejects.toThrow();
  });

  it("emits no doubled parentheses", async () => {
    // The regression from the condition-building bug that 500'd every interview
    // start: DynamoDB treats `((` as a ValidationException, not as harmless
    // nesting, and aws-sdk-client-mock does not parse expressions so no fragment
    // assertion can catch it.
    await chargeConductedSession({ userId: USER_ID });

    const expression = lastUpdate().ConditionExpression ?? "";
    expect(expression).not.toContain("((");
    expect(expression).not.toContain("))");
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
