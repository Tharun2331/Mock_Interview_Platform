import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import type { Options } from "express-rate-limit";
import { KEY_PREFIX, SORT_KEY } from "@repo/shared";
import { DynamoRateLimitStore } from "../../lib/rateLimitStore";

// The shared limiter store. One item per key that rolls itself forward, so the
// conditions are the behaviour and are asserted directly.

const dynamo = mockClient(DynamoDBDocumentClient);

const ADD = { ConditionExpression: "windowStart = :start" };
const ROLL = {
  ConditionExpression: "attribute_not_exists(windowStart) OR windowStart <> :start",
};

function conditionalFailure(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({ $metadata: {}, message: "no" });
}

function store(): DynamoRateLimitStore {
  const s = new DynamoRateLimitStore();
  s.init({ windowMs: 60_000 } as Options);
  return s;
}

beforeEach(() => dynamo.reset());
afterEach(() => dynamo.reset());

describe("DynamoRateLimitStore", () => {
  it("counts within the current window and reports the total", async () => {
    dynamo.on(UpdateCommand, ADD).resolves({ Attributes: { hits: 7 } });

    const result = await store().increment("user-1");

    expect(result.totalHits).toBe(7);
    expect(result.resetTime?.getTime()).toBeGreaterThan(Date.now());
    const input = dynamo.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({
      PK: `${KEY_PREFIX.RATE_LIMIT}user-1`,
      SK: SORT_KEY.RATE_LIMIT_WINDOW,
    });
    // Aligned to the window, so every task computes the same boundary.
    const start = Number(input?.ExpressionAttributeValues?.[":start"]);
    expect(start % 60_000).toBe(0);
  });

  it("rolls the item into a new window with a count of one", async () => {
    dynamo.on(UpdateCommand, ADD).rejects(conditionalFailure());
    dynamo.on(UpdateCommand, ROLL).resolves({});

    expect((await store().increment("user-1")).totalHits).toBe(1);
  });

  it("adds instead when a concurrent request rolled the window first", async () => {
    dynamo
      .on(UpdateCommand, ADD)
      .rejectsOnce(conditionalFailure())
      .resolves({ Attributes: { hits: 2 } });
    dynamo.on(UpdateCommand, ROLL).rejects(conditionalFailure());

    expect((await store().increment("user-1")).totalHits).toBe(2);
  });

  it("throws on a genuine failure so passOnStoreError can decide", async () => {
    dynamo.on(UpdateCommand).rejects(new Error("throughput"));

    expect(store().increment("user-1")).rejects.toThrow();
  });

  it("never credits a count below zero", async () => {
    dynamo.on(UpdateCommand).rejects(conditionalFailure());

    await store().decrement("user-1");

    const input = dynamo.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toContain("hits > :zero");
  });

  it("deletes the key on reset", async () => {
    dynamo.on(DeleteCommand).resolves({});

    await store().resetKey("user-1");

    expect(dynamo.commandCalls(DeleteCommand)).toHaveLength(1);
  });
});
