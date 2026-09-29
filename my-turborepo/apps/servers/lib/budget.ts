import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  ITEM_TYPE,
  SORT_KEY,
  sessionPk,
  userPk,
} from "@repo/shared";
import { config } from "./config";
import { dynamoClient, requireTable } from "./dynamo";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Spend controls for the text models.
//
// The rate limiter bounds how FAST a candidate can call the model-backed routes;
// nothing bounded how MUCH. Every text generation (Planner on a cache miss, Gap,
// Company Intel, Coach) now spends from two budgets before it runs:
//
//   per user, per UTC day    USER#<uid> / USAGE      config.modelCallsPerDay
//   per session              SESSION#<sid> / META    config.agentRunsPerSession
//
// Both are conditional writes, so the check and the spend are one operation and
// concurrent requests cannot both squeeze under a limit. Both live in DynamoDB,
// so they hold across every ECS task, unlike the in-memory limiter.
//
// Not metered here: the Sonic stream (the interview quota meters that) and the
// Evaluator (its calls are bounded by the answers of a conducted interview).

export type BudgetVerdict = "ok" | "daily_limit" | "session_limit";

// UTC, so every task and every candidate agree on when a day ends.
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const usageKey = (userId: string) => ({
  PK: userPk(userId),
  SK: SORT_KEY.USAGE,
});

// The raw AttributeValue shape a ConditionalCheckFailedException carries. It
// comes from the low-level client, below the document client's marshaller.
function failedItemDay(error: ConditionalCheckFailedException): string | null {
  const day = error.Item?.usageDay?.S;
  return typeof day === "string" ? day : null;
}

// Spends one call from the candidate's daily budget. True when it was spent,
// false when today's budget is already gone.
//
// One item per user rather than one per day, so nothing accumulates and erasure
// has one key to delete. The day rollover is a second conditional write:
//
//   1. ADD one, if the item is for today and under the cap.
//   2. If that fails because the item is for an earlier day (or missing), reset
//      it to today with a count of one, if it is still not today's.
//
// A concurrent request can win step 2 first. Then this one's step 2 fails too,
// and it goes round once more, where step 1 sees today's item.
export async function claimDailyModelCall(args: {
  userId: string;
}): Promise<boolean> {
  const TableName = requireTable();
  const day = today();
  const now = new Date().toISOString();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await dynamoClient.send(
        new UpdateCommand({
          TableName,
          Key: usageKey(args.userId),
          UpdateExpression: "SET updatedAt = :now ADD modelCalls :one",
          ConditionExpression: "usageDay = :day AND modelCalls < :cap",
          ExpressionAttributeValues: {
            ":now": now,
            ":one": 1,
            ":day": day,
            ":cap": config.modelCallsPerDay,
          },
          ReturnValuesOnConditionCheckFailure: "ALL_OLD",
        }),
      );
      return true;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw new ServiceError(
          `${MESSAGES.USAGE_WRITE_FAILED} — ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
      // Today's item exists, so the cap is what failed.
      if (failedItemDay(error) === day) return false;
    }

    try {
      await dynamoClient.send(
        new UpdateCommand({
          TableName,
          Key: usageKey(args.userId),
          UpdateExpression:
            "SET #type = :type, userId = :userId, usageDay = :day, " +
            "modelCalls = :one, updatedAt = :now",
          ConditionExpression: "attribute_not_exists(usageDay) OR usageDay <> :day",
          ExpressionAttributeNames: { "#type": "type" },
          ExpressionAttributeValues: {
            ":type": ITEM_TYPE.USER_USAGE,
            ":userId": args.userId,
            ":day": day,
            ":one": 1,
            ":now": now,
          },
        }),
      );
      // A cap of zero means "no generations at all", so even the first call of
      // the day is refused. Checked after the write so the item still rolls.
      return config.modelCallsPerDay > 0;
    } catch (error) {
      if (!(error instanceof ConditionalCheckFailedException)) {
        throw new ServiceError(
          `${MESSAGES.USAGE_WRITE_FAILED} — ${
            error instanceof Error ? error.message : "unknown"
          }`,
        );
      }
      // Another request rolled the day first. Go round again.
    }
  }

  // Contended twice in a row. Refusing is the safe direction for a spend control.
  return false;
}

// Spends one run from a session's allowance. Scoped to the owner in the same
// condition, so it can never be pointed at someone else's session.
export async function claimSessionAgentRun(args: {
  sessionId: string;
  userId: string;
}): Promise<boolean> {
  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: requireTable(),
        Key: { PK: sessionPk(args.sessionId), SK: SORT_KEY.META },
        UpdateExpression: "ADD agentRuns :one",
        ConditionExpression:
          "attribute_exists(PK) AND userId = :userId AND " +
          "(attribute_not_exists(agentRuns) OR agentRuns < :cap)",
        ExpressionAttributeValues: {
          ":one": 1,
          ":userId": args.userId,
          ":cap": config.agentRunsPerSession,
        },
      }),
    );
    return true;
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw new ServiceError(
      `${MESSAGES.USAGE_WRITE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }
}

// The one call routes make before a text generation.
//
// The session budget is checked first because it is the cheaper refusal to
// recover from: a spent session slot costs nothing, while a spent daily slot is
// a real generation the candidate did not get. Callers must have proven
// ownership already (loadPlannerInputs); the session condition repeats it.
export async function spendModelCall(args: {
  userId: string;
  sessionId?: string;
}): Promise<BudgetVerdict> {
  if (args.sessionId !== undefined) {
    const sessionOk = await claimSessionAgentRun({
      sessionId: args.sessionId,
      userId: args.userId,
    });
    if (!sessionOk) return "session_limit";
  }

  const dailyOk = await claimDailyModelCall({ userId: args.userId });
  return dailyOk ? "ok" : "daily_limit";
}

// Client copy for a refusal. Both are 429: the request was fine, the spend is
// what ran out.
export function budgetRefusalMessage(
  verdict: Exclude<BudgetVerdict, "ok">,
): string {
  return verdict === "daily_limit"
    ? MESSAGES.MODEL_BUDGET_EXHAUSTED
    : MESSAGES.SESSION_AGENT_LIMIT;
}
