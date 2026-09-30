import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { SORT_KEY, userPk, KEY_PREFIX } from "@repo/shared";

const ddb = mockClient(DynamoDBDocumentClient);
// Erasure also removes the archived resume. Without this the sweep reaches real
// S3 with whatever credentials the shell has.
const s3 = mockClient(S3Client);
// And the Cognito account itself, for the same reason.
const cognito = mockClient(CognitoIdentityProviderClient);

const { eraseUserAccount } = await import("../../lib/erasure");

const USER = "user-1";

beforeEach(() => {
  ddb.reset();
  ddb.on(UpdateCommand).resolves({});
  ddb.on(QueryCommand).resolves({ Items: [] });
  ddb.on(DeleteCommand).resolves({});
  ddb.on(PutCommand).resolves({});
  s3.reset();
  s3.on(DeleteObjectCommand).resolves({});
  cognito.reset();
  cognito.on(AdminDeleteUserCommand).resolves({});
});

afterAll(() => {
  ddb.restore();
  s3.restore();
  cognito.restore();
});

// The USER partition has no prefix sweep — its items sit at fixed sort keys
// that have to be named one by one. That makes "erasure deletes everything"
// a property nothing enforces structurally, so it is asserted here: a cache
// added without a line in `deleteProfileItems` is an item that outlives the
// account it belongs to.
describe("eraseUserAccount", () => {
  it("deletes every user-scoped sort key", async () => {
    await eraseUserAccount({ userId: USER, username: "tharun" });

    const deleted = ddb
      .commandCalls(DeleteCommand)
      .map((call) => call.args[0].input.Key)
      .filter((key) => key?.PK === userPk(USER))
      .map((key) => key?.SK);

    expect(deleted).toContain(SORT_KEY.PLAN);
    expect(deleted).toContain(SORT_KEY.COACH);
    // The daily model-call counter from lib/budget.ts.
    expect(deleted).toContain(SORT_KEY.USAGE);
  });

  it("deletes the shared rate limiter's counter for this user", async () => {
    await eraseUserAccount({ userId: USER, username: "tharun" });

    const keys = ddb
      .commandCalls(DeleteCommand)
      .map((call) => call.args[0].input.Key);

    expect(keys).toContainEqual({
      PK: `${KEY_PREFIX.RATE_LIMIT}${USER}`,
      SK: SORT_KEY.RATE_LIMIT_WINDOW,
    });
  });

  // The PROFILE item is replaced with a tombstone rather than deleted. Access
  // tokens outlive the Cognito user by up to an hour, and every profile write
  // is an upsert, so a deleted PROFILE let a stale token recreate the account.
  it("leaves a data-free tombstone in place of the profile", async () => {
    await eraseUserAccount({ userId: USER, username: "tharun" });

    const deletedProfile = ddb
      .commandCalls(DeleteCommand)
      .some((call) => call.args[0].input.Key?.SK === SORT_KEY.PROFILE);
    expect(deletedProfile).toBe(false);

    const tombstone = ddb
      .commandCalls(PutCommand)
      .map((call) => call.args[0].input.Item)
      .find((item) => item?.PK === userPk(USER) && item?.SK === SORT_KEY.PROFILE);

    // `deleting` is the status every write path already refuses.
    expect(tombstone?.status).toBe("deleting");
    expect(tombstone?.erasedAt).toBeDefined();
    expect(tombstone?.expiresAt).toBeGreaterThan(Date.now() / 1000);
    // Nothing that identifies a person survives in it.
    expect(Object.keys(tombstone ?? {}).sort()).toEqual(
      ["PK", "SK", "erasedAt", "expiresAt", "status"].sort(),
    );
  });

  it("removes the derived items before writing the tombstone", async () => {
    // Same ordering logic as before: the profile slot is the record that a
    // sweep started, so it is the last thing to change.
    await eraseUserAccount({ userId: USER, username: "tharun" });

    const calls = ddb.calls();
    const coachDelete = calls.findIndex(
      (call) =>
        (call.args[0].input as { Key?: { SK?: string } }).Key?.SK ===
        SORT_KEY.COACH,
    );
    const tombstoneWrite = calls.findIndex(
      (call) =>
        (call.args[0].input as { Item?: { SK?: string } }).Item?.SK ===
        SORT_KEY.PROFILE,
    );
    expect(coachDelete).toBeGreaterThanOrEqual(0);
    expect(coachDelete).toBeLessThan(tombstoneWrite);
  });
});
