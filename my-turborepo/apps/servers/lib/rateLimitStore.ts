import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type {
  IncrementResponse,
  Options,
  Store,
} from "express-rate-limit";
import { ITEM_TYPE, KEY_PREFIX, SORT_KEY } from "@repo/shared";
import { dynamoClient, requireTable } from "./dynamo";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// A fixed-window express-rate-limit store shared across every ECS task, kept in
// the sessions table.
//
// Why not the default MemoryStore: it counts per process, so behind the ALB the
// real limit is `limit x taskCount`, and a deploy or crash resets everyone to
// zero. Redis was the original destination and was dropped (ADR-0006), so this
// uses the one datastore the service already has and already holds IAM for.
//
// ONE item per key (`RATELIMIT#<key>` / `WINDOW`) that resets itself when the
// window moves, rather than one item per window. That matters because prod has
// no TTL on the table: a per-window layout would add a row per active user per
// minute, forever. `expiresAt` is still written, so environments that do run TTL
// drop the rows of callers who have gone quiet.
//
// Opt-in via RATE_LIMIT_STORE=dynamodb. Cost is one conditional write per API
// request (two on the first request of each window).

// Kept for a day past the window, which is plenty for TTL housekeeping and far
// too short to matter as retention for an IP address.
const EXPIRY_SECONDS = 24 * 60 * 60;

export class DynamoRateLimitStore implements Store {
  windowMs = 60_000;

  // Counts live outside this process, so express-rate-limit must not assume it
  // can reason about them locally.
  localKeys = false;

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  private windowStart(now: number): number {
    return Math.floor(now / this.windowMs) * this.windowMs;
  }

  private key(key: string) {
    return {
      PK: `${KEY_PREFIX.RATE_LIMIT}${key}`,
      SK: SORT_KEY.RATE_LIMIT_WINDOW,
    };
  }

  // Same two-step shape as the daily model budget in lib/budget.ts: add to the
  // current window if the item is in it, otherwise roll the item forward to the
  // current window with a count of one. A concurrent roll makes the second step
  // fail, and the loop goes round to add instead.
  async increment(key: string): Promise<IncrementResponse> {
    const TableName = requireTable();
    const now = Date.now();
    const start = this.windowStart(now);
    const resetTime = new Date(start + this.windowMs);
    const expiresAt = Math.floor(now / 1000) + EXPIRY_SECONDS;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await dynamoClient.send(
          new UpdateCommand({
            TableName,
            Key: this.key(key),
            UpdateExpression: "SET expiresAt = :exp ADD hits :one",
            ConditionExpression: "windowStart = :start",
            ExpressionAttributeValues: {
              ":one": 1,
              ":start": start,
              ":exp": expiresAt,
            },
            ReturnValues: "UPDATED_NEW",
          }),
        );
        const hits = response.Attributes?.hits;
        return { totalHits: typeof hits === "number" ? hits : 1, resetTime };
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw failure(error);
        }
      }

      try {
        await dynamoClient.send(
          new UpdateCommand({
            TableName,
            Key: this.key(key),
            UpdateExpression:
              "SET #type = :type, windowStart = :start, hits = :one, expiresAt = :exp",
            ConditionExpression:
              "attribute_not_exists(windowStart) OR windowStart <> :start",
            ExpressionAttributeNames: { "#type": "type" },
            ExpressionAttributeValues: {
              ":type": ITEM_TYPE.RATE_LIMIT_WINDOW,
              ":start": start,
              ":one": 1,
              ":exp": expiresAt,
            },
          }),
        );
        return { totalHits: 1, resetTime };
      } catch (error) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw failure(error);
        }
      }
    }

    throw new ServiceError(
      `${MESSAGES.RATE_LIMIT_STORE_FAILED} — contended on ${key}`,
    );
  }

  // Used by express-rate-limit's skip options, which this service does not set.
  // Implemented anyway because the interface requires it; floored at zero and
  // scoped to the current window so it cannot credit a future one.
  async decrement(key: string): Promise<void> {
    try {
      await dynamoClient.send(
        new UpdateCommand({
          TableName: requireTable(),
          Key: this.key(key),
          UpdateExpression: "ADD hits :minusOne",
          ConditionExpression: "windowStart = :start AND hits > :zero",
          ExpressionAttributeValues: {
            ":minusOne": -1,
            ":zero": 0,
            ":start": this.windowStart(Date.now()),
          },
        }),
      );
    } catch (error) {
      if (error instanceof ConditionalCheckFailedException) return;
      throw failure(error);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await dynamoClient.send(
        new DeleteCommand({ TableName: requireTable(), Key: this.key(key) }),
      );
    } catch (error) {
      throw failure(error);
    }
  }
}

function failure(error: unknown): ServiceError {
  return new ServiceError(
    `${MESSAGES.RATE_LIMIT_STORE_FAILED} — ${
      error instanceof Error ? error.message : "unknown"
    }`,
  );
}
