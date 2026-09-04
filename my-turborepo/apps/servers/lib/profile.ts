import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  CachedPlanSchema,
  PLAN_LIMITS,
  SORT_KEY,
  UserProfileSchema,
  userPk,
  type CachedPlan,
  type PlanResponse,
  type PreInterviewRepo,
  type UserProfile,
} from "@repo/shared";
import { dynamoClient, parseItem, requireTable } from "./dynamo";
import { ProfileStateError, ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Every DynamoDB command for the user-scoped items lives here, matching how
// lib/sessions.ts owns the session lifecycle and lib/s3.ts owns object writes.
// This module decides key layout; routes decide status codes.

const PROFILE_CONTEXT = "PROFILE";
const PLAN_CONTEXT = "PLAN";

const profileKey = (userId: string) => ({
  PK: userPk(userId),
  SK: SORT_KEY.PROFILE,
});

const cachedPlanKey = (userId: string) => ({
  PK: userPk(userId),
  SK: SORT_KEY.PLAN,
});

// A write is refused once erasure has been requested. Applied to every mutating
// path rather than checked once in a route: the marker is what stops an account
// being repopulated by a request that was already in flight when the deletion
// arrived, and a check that lives in one handler does not cover the others.
const NOT_DELETING = "attribute_not_exists(#status) OR #status <> :deleting";

function readFailure(error: unknown, message: string): ServiceError {
  return new ServiceError(
    `${message} — ${error instanceof Error ? error.message : "unknown"}`
  );
}

// Returns null when no profile exists, which is the onboarding signal — a
// first-time candidate rather than an error. Distinct from a profile that
// exists but is incomplete, which `isProfileComplete` answers.
export async function getProfile(args: {
  userId: string;
}): Promise<UserProfile | null> {
  const TableName = requireTable();

  let response;
  try {
    response = await dynamoClient.send(
      new GetCommand({
        TableName,
        Key: profileKey(args.userId),
        // Strongly consistent. A candidate can save their profile and land on
        // the role-selection page in well under a second, and an eventually
        // consistent read here would intermittently bounce them back into
        // onboarding they have just completed.
        ConsistentRead: true,
      })
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.PROFILE_READ_FAILED);
  }

  if (response.Item === undefined) return null;

  return parseItem(UserProfileSchema, response.Item, PROFILE_CONTEXT);
}

// Upsert rather than create-then-update: the first save and every later edit are
// the same request, and splitting them would mean a read to decide which one
// this is — a read that races the write it is deciding about.
//
// Deliberately does NOT touch profileVersion. A display name has no bearing on
// the plan, so bumping it here would invalidate the cache and buy a Planner call
// for nothing.
export async function saveProfileDetails(args: {
  userId: string;
  username: string;
  firstName: string;
  lastName: string;
}): Promise<UserProfile> {
  const TableName = requireTable();
  const now = new Date().toISOString();

  let response;
  try {
    response = await dynamoClient.send(
      new UpdateCommand({
        TableName,
        Key: profileKey(args.userId),
        UpdateExpression: [
          "SET userId = :userId",
          "#status = if_not_exists(#status, :active)",
          "username = :username",
          "firstName = :firstName",
          "lastName = :lastName",
          "createdAt = if_not_exists(createdAt, :now)",
          "updatedAt = :now",
          // Seeded here so the attribute exists from the first save. The resume
          // path uses ADD, which would initialise it anyway, but a profile read
          // between the two would otherwise fail its schema.
          "profileVersion = if_not_exists(profileVersion, :zero)",
        ].join(", "),
        ConditionExpression: NOT_DELETING,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":userId": args.userId,
          ":active": "active",
          ":deleting": "deleting",
          ":username": args.username,
          ":firstName": args.firstName,
          ":lastName": args.lastName,
          ":now": now,
          ":zero": 0,
        },
        ReturnValues: "ALL_NEW",
      })
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new ProfileStateError(MESSAGES.PROFILE_DELETING);
    }
    throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
  }

  return parseItem(UserProfileSchema, response.Attributes, PROFILE_CONTEXT);
}

// Writes the candidate's Planner material and bumps the version in one update.
//
// One item, one command, so the text and the version marker cannot disagree.
// That is the whole reason the redacted text is stored here rather than in S3
// beside the PDF: across two stores, a failure between the two writes leaves new
// material behind an old version, the plan cache does not invalidate, and the
// Planner reasons over a resume that is no longer the candidate's.
//
// `resumeText` must already be redacted. This module does not check that — it
// cannot tell redacted text from raw — so the guarantee belongs to the caller,
// and lib/redact.ts is the only thing that should be producing this argument.
export async function saveResumeAndRepos(args: {
  userId: string;
  resumeKey: string;
  resumeText: string;
  repos: PreInterviewRepo[];
  githubUsername: string | null;
}): Promise<UserProfile> {
  const TableName = requireTable();
  const now = new Date().toISOString();

  const setClauses = [
    "userId = :userId",
    "#status = if_not_exists(#status, :active)",
    "resumeKey = :resumeKey",
    "resumeText = :resumeText",
    "repos = :repos",
    "createdAt = if_not_exists(createdAt, :now)",
    "updatedAt = :now",
  ];

  const values: Record<string, unknown> = {
    ":userId": args.userId,
    ":active": "active",
    ":deleting": "deleting",
    ":resumeKey": args.resumeKey,
    // Capped on the way in, both bounds taken from the schema this item is
    // validated against on read — so a stored item can never be too large for
    // its own validator to accept.
    ":resumeText": args.resumeText.slice(0, PLAN_LIMITS.MAX_RESUME_CHARS),
    ":repos": args.repos.slice(0, PLAN_LIMITS.MAX_REPOS),
    ":now": now,
    ":one": 1,
  };

  // Cleared rather than written as null when a candidate removes their profile:
  // the schema reads absence as "not given", and a stored null would have to be
  // spelled as optional-and-nullable everywhere it is read.
  const removeClauses: string[] = [];
  if (args.githubUsername === null) {
    removeClauses.push("githubUsername");
  } else {
    setClauses.push("githubUsername = :githubUsername");
    values[":githubUsername"] = args.githubUsername;
  }

  const expression = [
    `SET ${setClauses.join(", ")}`,
    ...(removeClauses.length > 0 ? [`REMOVE ${removeClauses.join(", ")}`] : []),
    // ADD, not SET with a read value: the bump has to be atomic. Two uploads
    // racing would otherwise both read version 3 and both write 4, leaving a
    // cached plan that matches material neither of them stored.
    "ADD profileVersion :one",
  ].join(" ");

  let response;
  try {
    response = await dynamoClient.send(
      new UpdateCommand({
        TableName,
        Key: profileKey(args.userId),
        UpdateExpression: expression,
        ConditionExpression: NOT_DELETING,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      })
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new ProfileStateError(MESSAGES.PROFILE_DELETING);
    }
    throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
  }

  return parseItem(UserProfileSchema, response.Attributes, PROFILE_CONTEXT);
}

// Null when nothing is cached — a first interview, or a plan already evicted.
//
// Throws on a genuine read failure rather than degrading to null, so the route
// decides whether a broken cache is worth failing the request over. A cache miss
// and a cache outage cost the same thing here (one Planner call), but only one
// of them should show up in the logs as normal.
export async function getCachedPlan(args: {
  userId: string;
}): Promise<CachedPlan | null> {
  const TableName = requireTable();

  let response;
  try {
    response = await dynamoClient.send(
      new GetCommand({
        TableName,
        Key: cachedPlanKey(args.userId),
        ConsistentRead: true,
      })
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.PLAN_CACHE_READ_FAILED);
  }

  if (response.Item === undefined) return null;

  return parseItem(CachedPlanSchema, response.Item, PLAN_CONTEXT);
}

// Overwrites unconditionally — one plan per user, and the newest generation is
// always the one worth keeping.
//
// The caller stamps the version it actually planned against, read before the
// Bedrock call rather than after. Re-reading here would pick up a profile saved
// while the model was running and mark a stale plan fresh.
export async function putCachedPlan(args: {
  userId: string;
  plan: PlanResponse;
  targetRole: string;
  profileVersion: number;
}): Promise<void> {
  const TableName = requireTable();

  try {
    await dynamoClient.send(
      new PutCommand({
        TableName,
        Item: {
          ...cachedPlanKey(args.userId),
          plan: args.plan,
          targetRole: args.targetRole,
          profileVersion: args.profileVersion,
          generatedAt: new Date().toISOString(),
        },
      })
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.PLAN_CACHE_SAVE_FAILED);
  }
}
