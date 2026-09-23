import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  AdminDeleteUserCommand,
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { SORT_KEY, userPk } from "@repo/shared";

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

    expect(deleted).toContain(SORT_KEY.PROFILE);
    expect(deleted).toContain(SORT_KEY.PLAN);
    expect(deleted).toContain(SORT_KEY.COACH);
  });

  it("removes the cached coaching report before the profile it was built from", async () => {
    // Same ordering logic as the plan cache: a derived item outliving its
    // source is an orphan nothing reads and nothing will ever delete.
    await eraseUserAccount({ userId: USER, username: "tharun" });

    const order = ddb
      .commandCalls(DeleteCommand)
      .map((call) => call.args[0].input.Key)
      .filter((key) => key?.PK === userPk(USER))
      .map((key) => key?.SK);

    expect(order.indexOf(SORT_KEY.COACH)).toBeLessThan(
      order.indexOf(SORT_KEY.PROFILE),
    );
  });
});
