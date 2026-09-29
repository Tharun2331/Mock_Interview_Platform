import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { SORT_KEY, sessionPk, userPk } from "@repo/shared";
import {
  claimDailyModelCall,
  claimSessionAgentRun,
  spendModelCall,
} from "../../lib/budget";

// The text-model spend budgets. Both are conditional writes, and the CONDITION
// is the behaviour, so these assert on the command that was built as well as on
// what came back. Mocked at the client class, like the other lib suites.

const dynamo = mockClient(DynamoDBDocumentClient);

const USER_ID = "sub-1";
const SESSION_ID = "01J000000000000000000000";

const ADD_TODAY = { ConditionExpression: "usageDay = :day AND modelCalls < :cap" };
const ROLL_DAY = {
  ConditionExpression: "attribute_not_exists(usageDay) OR usageDay <> :day",
};
const SESSION_RUN = { UpdateExpression: "ADD agentRuns :one" };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// A failed condition carrying the stored item, the way DynamoDB returns it with
// ReturnValuesOnConditionCheckFailure: raw AttributeValues.
function failedWithDay(day: string | null): ConditionalCheckFailedException {
  const error = new ConditionalCheckFailedException({
    $metadata: {},
    message: "no",
  });
  if (day !== null) Object.assign(error, { Item: { usageDay: { S: day } } });
  return error;
}

function inputs() {
  return dynamo.commandCalls(UpdateCommand).map((call) => call.args[0].input);
}

beforeEach(() => {
  dynamo.reset();
});

afterEach(() => {
  dynamo.reset();
});

describe("claimDailyModelCall", () => {
  it("spends from today's item when it is under the cap", async () => {
    dynamo.on(UpdateCommand).resolves({});

    expect(await claimDailyModelCall({ userId: USER_ID })).toBe(true);

    const [first] = inputs();
    expect(first?.Key).toEqual({ PK: userPk(USER_ID), SK: SORT_KEY.USAGE });
    expect(first?.UpdateExpression).toContain("ADD modelCalls :one");
    expect(first?.ExpressionAttributeValues?.[":day"]).toBe(today());
    // The configured cap from setup.ts.
    expect(first?.ExpressionAttributeValues?.[":cap"]).toBe(40);
  });

  it("refuses without a second write once today's cap is reached", async () => {
    dynamo.on(UpdateCommand, ADD_TODAY).rejects(failedWithDay(today()));

    expect(await claimDailyModelCall({ userId: USER_ID })).toBe(false);
    expect(inputs()).toHaveLength(1);
  });

  it("rolls a stale day over to today with a count of one", async () => {
    dynamo.on(UpdateCommand, ADD_TODAY).rejects(failedWithDay("2020-01-01"));
    dynamo.on(UpdateCommand, ROLL_DAY).resolves({});

    expect(await claimDailyModelCall({ userId: USER_ID })).toBe(true);

    const roll = inputs().find(
      (input) => input.ConditionExpression === ROLL_DAY.ConditionExpression,
    );
    expect(roll?.ExpressionAttributeValues?.[":one"]).toBe(1);
    expect(roll?.ExpressionAttributeValues?.[":day"]).toBe(today());
  });

  it("creates the item on a candidate's first call", async () => {
    dynamo.on(UpdateCommand, ADD_TODAY).rejects(failedWithDay(null));
    dynamo.on(UpdateCommand, ROLL_DAY).resolves({});

    expect(await claimDailyModelCall({ userId: USER_ID })).toBe(true);
  });

  it("goes round again when another request rolled the day first", async () => {
    // Step 1 sees yesterday; step 2 loses to a concurrent roll; the retry of
    // step 1 then finds today's item and adds to it.
    dynamo
      .on(UpdateCommand, ADD_TODAY)
      .rejectsOnce(failedWithDay("2020-01-01"))
      .resolves({});
    dynamo.on(UpdateCommand, ROLL_DAY).rejects(failedWithDay(today()));

    expect(await claimDailyModelCall({ userId: USER_ID })).toBe(true);
  });

  it("throws on a genuine write failure rather than reporting a refusal", async () => {
    dynamo.on(UpdateCommand).rejects(new Error("ProvisionedThroughputExceeded"));

    expect(claimDailyModelCall({ userId: USER_ID })).rejects.toThrow();
  });
});

describe("claimSessionAgentRun", () => {
  it("adds a run, capped and scoped to the owner in one condition", async () => {
    dynamo.on(UpdateCommand).resolves({});

    expect(
      await claimSessionAgentRun({ sessionId: SESSION_ID, userId: USER_ID }),
    ).toBe(true);

    const [input] = inputs();
    expect(input?.Key).toEqual({ PK: sessionPk(SESSION_ID), SK: SORT_KEY.META });
    expect(input?.ConditionExpression).toContain("userId = :userId");
    expect(input?.ConditionExpression).toContain("agentRuns < :cap");
    expect(input?.ExpressionAttributeValues?.[":cap"]).toBe(8);
  });

  it("refuses once the session's runs are spent, or it is not theirs", async () => {
    dynamo.on(UpdateCommand).rejects(failedWithDay(null));

    expect(
      await claimSessionAgentRun({ sessionId: SESSION_ID, userId: USER_ID }),
    ).toBe(false);
  });
});

describe("spendModelCall", () => {
  it("checks the session before spending from the day", async () => {
    // Catch-all first, specific second: reversed, the catch-all wins.
    dynamo.on(UpdateCommand).resolves({});
    dynamo.on(UpdateCommand, SESSION_RUN).rejects(failedWithDay(null));

    expect(
      await spendModelCall({ userId: USER_ID, sessionId: SESSION_ID }),
    ).toBe("session_limit");
    // The daily budget was never touched.
    expect(inputs()).toHaveLength(1);
  });

  it("reports the daily limit when only that is spent", async () => {
    dynamo.on(UpdateCommand).resolves({});
    dynamo.on(UpdateCommand, ADD_TODAY).rejects(failedWithDay(today()));

    expect(
      await spendModelCall({ userId: USER_ID, sessionId: SESSION_ID }),
    ).toBe("daily_limit");
  });

  it("spends only the daily budget when there is no session", async () => {
    dynamo.on(UpdateCommand).resolves({});

    expect(await spendModelCall({ userId: USER_ID })).toBe("ok");
    expect(inputs()).toHaveLength(1);
  });
});
