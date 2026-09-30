import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ADMIN_PROFILE_FIELDS,
  resolveSessionAllowance,
  type SessionAllowance,
  AdminProfileProjectionSchema,
  CachedCoachSchema,
  CachedPlanSchema,
  ITEM_TYPE,
  KEY_PREFIX,
  PLAN_LIMITS,
  SORT_KEY,
  UserProfileSchema,
  userPk,
  type AdminProfileProjection,
  type CachedCoach,
  type CachedPlan,
  type CoachCacheStamp,
  type CoachProse,
  type PlanResponse,
  type PreInterviewRepo,
  type UserProfile,
} from "@repo/shared";
import { dynamoClient, parseItem, requireTable } from "./dynamo";
import { ProfileStateError, ServiceError } from "./errors";
import { aliasedProjection } from "./evaluations";
import { MESSAGES } from "./messages";

// Every DynamoDB command for the user-scoped items lives here, matching how
// lib/sessions.ts owns the session lifecycle and lib/s3.ts owns object writes.
// This module decides key layout; routes decide status codes.

const PROFILE_CONTEXT = "PROFILE";
const PLAN_CONTEXT = "PLAN";
const COACH_CONTEXT = "COACH";

// BatchGetItem's hard cap on keys per call. Not a tuning value — asking for 101
// is a validation error, not a slower request. Same shape as DELETE_BATCH_SIZE's
// 25 for BatchWriteItem in lib/sessions.ts and SQS.SEND_BATCH_SIZE's 10.
//
// The admin table never reaches it: its page size is Cognito's ListUsers maximum
// of 60. `getAdminProfiles` throws rather than chunking if that ever stops being
// true, because a silently chunked read would double the request count of an
// admin page load without anyone noticing.
const BATCH_GET_LIMIT = 100;

const profileKey = (userId: string) => ({
  PK: userPk(userId),
  SK: SORT_KEY.PROFILE,
});

const cachedPlanKey = (userId: string) => ({
  PK: userPk(userId),
  SK: SORT_KEY.PLAN,
});

// SORT_KEY.COACH is also the SK of the per-session RAG sketch in session.ts.
// Different partition — SESSION#<sid> there, USER#<uid> here — so the two
// cannot collide, and nothing writes that one.
const cachedCoachKey = (userId: string) => ({
  PK: userPk(userId),
  SK: SORT_KEY.COACH,
});

// A write is refused once erasure has been requested. Applied to every mutating
// path rather than checked once in a route: the marker is what stops an account
// being repopulated by a request that was already in flight when the deletion
// arrived, and a check that lives in one handler does not cover the others.
const NOT_DELETING = "attribute_not_exists(#status) OR #status <> :deleting";

function readFailure(error: unknown, message: string): ServiceError {
  return new ServiceError(
    `${message} — ${error instanceof Error ? error.message : "unknown"}`,
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
      }),
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.PROFILE_READ_FAILED);
  }

  if (response.Item === undefined) return null;

  // An erasure tombstone (see deleteProfileItems) reads as "no profile". It has
  // none of the profile's fields, so parsing it would be a 500 for what is just
  // a stale token belonging to a deleted account.
  if (response.Item.erasedAt !== undefined) return null;

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
          "#type = :type",
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
        // Both aliased: `status` and `type` are DynamoDB reserved words, and an
        // unaliased reserved word fails the request rather than the attribute.
        ExpressionAttributeNames: { "#status": "status", "#type": "type" },
        ExpressionAttributeValues: {
          ":userId": args.userId,
          ":type": ITEM_TYPE.USER_PROFILE,
          ":active": "active",
          ":deleting": "deleting",
          ":username": args.username,
          ":firstName": args.firstName,
          ":lastName": args.lastName,
          ":now": now,
          ":zero": 0,
        },
        ReturnValues: "ALL_NEW",
      }),
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
    "#type = :type",
    "#status = if_not_exists(#status, :active)",
    "resumeKey = :resumeKey",
    "resumeText = :resumeText",
    "repos = :repos",
    "createdAt = if_not_exists(createdAt, :now)",
    "updatedAt = :now",
  ];

  const values: Record<string, unknown> = {
    ":userId": args.userId,
    ":type": ITEM_TYPE.USER_PROFILE,
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
        ExpressionAttributeNames: { "#status": "status", "#type": "type" },
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new ProfileStateError(MESSAGES.PROFILE_DELETING);
    }
    throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
  }

  return parseItem(UserProfileSchema, response.Attributes, PROFILE_CONTEXT);
}

// Phase one of erasure. Flips the profile to `deleting` and nothing else.
//
// This is the only step that has to happen before anything is destroyed, and it
// is deliberately its own write: from here every mutating path refuses the
// account, including a request that was already in flight when the deletion
// arrived. The marker also outlives a failed sweep, which is what makes the
// sweep resumable — it is removed last, by deleteProfileItems.
//
// Returns false when there is no profile to mark. A candidate who signed up and
// never saved one still has an account to erase, so that is not an error.
export async function markProfileDeleting(args: {
  userId: string;
}): Promise<boolean> {
  const TableName = requireTable();

  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName,
        Key: profileKey(args.userId),
        UpdateExpression: "SET #status = :deleting, updatedAt = :now",
        // Without this the update would create the very item it is meant to be
        // tearing down.
        ConditionExpression: "attribute_exists(PK)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":deleting": "deleting",
          ":now": new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
  }

  return true;
}

// Final phase. The PROFILE item goes last on purpose: while it exists carrying
// `deleting`, it is the record that a sweep was started and may not have
// finished. Removing it first would leave any survivors unreachable and
// invisible.
export async function deleteProfileItems(args: {
  userId: string;
}): Promise<void> {
  const TableName = requireTable();

  // Derived items first, profile last — same ordering logic one level down.
  //
  // Every user-scoped SK must be named here. There is no prefix sweep for this
  // partition, so a new cache added without a line in this array is an item
  // that survives an erasure request.
  for (const Key of [
    cachedPlanKey(args.userId),
    cachedCoachKey(args.userId),
    // The daily model-call counter (lib/budget.ts) and the shared rate
    // limiter's window (lib/rateLimitStore.ts). Both name the user.
    { PK: userPk(args.userId), SK: SORT_KEY.USAGE },
    { PK: `${KEY_PREFIX.RATE_LIMIT}${args.userId}`, SK: SORT_KEY.RATE_LIMIT_WINDOW },
  ]) {
    try {
      await dynamoClient.send(new DeleteCommand({ TableName, Key }));
    } catch (error) {
      throw readFailure(error, MESSAGES.PROFILE_DELETE_FAILED);
    }
  }

  // The PROFILE item is REPLACED with a tombstone, not deleted.
  //
  // Deleting it re-opened the account to a token that outlived it. Access tokens
  // are verified locally and stay valid for up to an hour after Cognito deletes
  // the user, and every profile write is an upsert, so PUT /profile with that
  // token recreated a profile under the erased user's id. Deleting the Cognito
  // user already stops refresh, so the access token is the whole gap.
  //
  // The tombstone carries `status: "deleting"`, which every write path already
  // refuses through NOT_DELETING, so no write path needed changing. It holds
  // nothing but the key, the status and timestamps: the sub is a random id with
  // nothing left that links it to a person. `expiresAt` lets TTL remove it where
  // the table has TTL on, well after any token issued to the account has expired.
  const now = Date.now();
  try {
    await dynamoClient.send(
      new PutCommand({
        TableName,
        Item: {
          ...profileKey(args.userId),
          status: "deleting",
          erasedAt: new Date(now).toISOString(),
          expiresAt: Math.floor(now / 1000) + ERASURE_TOMBSTONE_SECONDS,
        },
      }),
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.PROFILE_DELETE_FAILED);
  }
}

// How long an erasure tombstone must outlive the account. Cognito access tokens
// live one hour here; a day leaves a wide margin for clock skew and for the
// validity being raised later.
const ERASURE_TOMBSTONE_SECONDS = 24 * 60 * 60;

// Replaces the GitHub half of the candidate's material without touching the
// resume half.
//
// Exists because the resume route requires a file. Without this, changing a
// GitHub URL — or removing it — would mean re-attaching a PDF that has not
// changed, which is the kind of friction that stops people keeping a profile
// current.
//
// Bumps profileVersion for the same reason the resume path does: repos are
// Planner input, so a plan built before this is no longer built from the
// candidate's material.
export async function saveGithubRepos(args: {
  userId: string;
  githubUsername: string | null;
  repos: PreInterviewRepo[];
}): Promise<UserProfile> {
  const TableName = requireTable();
  const now = new Date().toISOString();

  const setClauses = [
    "userId = :userId",
    "#type = :type",
    "#status = if_not_exists(#status, :active)",
    "repos = :repos",
    "createdAt = if_not_exists(createdAt, :now)",
    "updatedAt = :now",
  ];

  const values: Record<string, unknown> = {
    ":userId": args.userId,
    ":type": ITEM_TYPE.USER_PROFILE,
    ":active": "active",
    ":deleting": "deleting",
    ":repos": args.repos.slice(0, PLAN_LIMITS.MAX_REPOS),
    ":now": now,
    ":one": 1,
  };

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
        ExpressionAttributeNames: { "#status": "status", "#type": "type" },
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      throw new ProfileStateError(MESSAGES.PROFILE_DELETING);
    }
    throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
  }

  return parseItem(UserProfileSchema, response.Attributes, PROFILE_CONTEXT);
}

// ---------------------------------------------------------------------------
// Interview quota
//
// Three attributes on the PROFILE item, resolved by `resolveSessionAllowance` in
// @repo/shared. This module owns the writes; the shared function owns what they
// mean; routes own the status codes.
// ---------------------------------------------------------------------------

// Reads the admin-table slice of many profiles in one request.
//
// Returns a Map keyed by userId, and an id simply missing from it is the answer
// for an account that signed up and never onboarded — a real and common state,
// not an error. BatchGetItem omits misses rather than reporting them, which is
// the same property `loadPlannerInputs` relies on and the reason this returns a
// Map instead of an array the caller would have to align by position.
//
// Bounded by the caller's page size, which is Cognito's ListUsers maximum of 60 —
// comfortably under BatchGetItem's own limit of 100 keys, so this never has to
// chunk. The assertion below is what will notice if either limit changes.
export async function getAdminProfiles(args: {
  userIds: string[];
}): Promise<Map<string, AdminProfileProjection>> {
  const found = new Map<string, AdminProfileProjection>();
  if (args.userIds.length === 0) return found;

  const TableName = requireTable();

  if (args.userIds.length > BATCH_GET_LIMIT) {
    throw new ServiceError(
      `${MESSAGES.ADMIN_DIRECTORY_FAILED} — asked for ${args.userIds.length} ` +
        `profiles in one BatchGetItem, which caps at ${BATCH_GET_LIMIT}`,
    );
  }

  let response;
  try {
    response = await dynamoClient.send(
      new BatchGetCommand({
        RequestItems: {
          [TableName]: {
            Keys: args.userIds.map((userId) => profileKey(userId)),
            // Every name aliased, unconditionally. `status` is a DynamoDB
            // reserved word and so is `type`; aliasing only the ones that look
            // reserved is how the history page and the completion query have both
            // already broken. See aliasedProjection's own comment.
            ...aliasedProjection(ADMIN_PROFILE_FIELDS),
          },
        },
      }),
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.PROFILE_READ_FAILED);
  }

  // Not retried. Unlike the erasure sweep, which must finish, an unprocessed key
  // here costs one row in the admin table showing as un-onboarded — visibly odd
  // and fixed by a refresh, against a retry loop on a read-only listing. Logged so
  // the odd row has an explanation somewhere.
  const unprocessed = response.UnprocessedKeys?.[TableName]?.Keys?.length ?? 0;
  if (unprocessed > 0) {
    console.warn(
      `[admin] BatchGetItem left ${unprocessed} profile keys unprocessed; ` +
        `those rows will show as not onboarded`,
    );
  }

  for (const item of response.Responses?.[TableName] ?? []) {
    // Validated per item rather than over the batch, so one row written by an
    // older deploy cannot fail the whole page. A row that does not parse is
    // dropped to un-onboarded and logged — the admin table is a read-only view,
    // and failing it entirely over one bad row would hide the other fifty-nine.
    const parsed = AdminProfileProjectionSchema.safeParse(item);
    if (!parsed.success) {
      console.warn(
        `[admin] skipped an unparseable PROFILE row — ` +
          `${parsed.error.issues
            .map((issue) => issue.path.join(".") || "root")
            .join(", ")}`,
      );
      continue;
    }
    found.set(parsed.data.userId, parsed.data);
  }

  return found;
}

// Writes an admin's grant. The only mutating path in this module whose caller is
// not the account's own owner, which is why it takes a userId it did not get from
// a token — `routes/admin.ts` resolves that from an email through Cognito, behind
// RequireAdmin.
//
// Does NOT touch `profileVersion`. A quota grant changes nothing the Planner
// reads, so bumping it would discard a good cached plan and buy a Bedrock call
// for an administrative act — the same reasoning `saveProfileDetails` carries for
// a display name.
//
// `attribute_exists(PK)` rather than an upsert, unlike every other write here.
// A grant against an account with no profile must fail rather than conjure a
// PROFILE item holding nothing but a quota: that item would fail
// `UserProfileSchema` on the next read (no `userId`, no `status`, no timestamps)
// and would make an un-onboarded account indistinguishable from an onboarded one
// in the admin table. The route turns this into ADMIN_PROFILE_MISSING, which says
// what actually happened.
export async function setAccessGrant(args: {
  userId: string;
  unlimitedAccess: boolean;
  sessionLimit: number | undefined;
}): Promise<UserProfile | null> {
  const TableName = requireTable();

  const setClauses = ["unlimitedAccess = :unlimited", "updatedAt = :now"];
  const values: Record<string, unknown> = {
    ":unlimited": args.unlimitedAccess,
    ":now": new Date().toISOString(),
    ":deleting": "deleting",
  };

  // Removed rather than written as null when the grant carries no number, for
  // the reason `githubUsername` is: the schema reads absence as "no override"
  // and a stored null would have to be spelled optional-and-nullable everywhere.
  // This is also what makes revoking a numeric grant possible at all — without
  // the REMOVE, lowering someone from 50 back to the default would need the
  // admin to type 3 and would silently break if the default ever changed.
  const removeClauses: string[] = [];
  if (args.sessionLimit === undefined) {
    removeClauses.push("sessionLimit");
  } else {
    setClauses.push("sessionLimit = :limit");
    values[":limit"] = args.sessionLimit;
  }

  const expression = [
    `SET ${setClauses.join(", ")}`,
    ...(removeClauses.length > 0 ? [`REMOVE ${removeClauses.join(", ")}`] : []),
  ].join(" ");

  let response;
  try {
    response = await dynamoClient.send(
      new UpdateCommand({
        TableName,
        Key: profileKey(args.userId),
        UpdateExpression: expression,
        ConditionExpression: `attribute_exists(PK) AND (${NOT_DELETING})`,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: values,
        ReturnValues: "ALL_NEW",
      }),
    );
  } catch (error) {
    // Null covers both conditions the expression can fail on: no profile, and a
    // profile mid-erasure. Collapsed on purpose — an account being deleted has
    // nothing an admin should be granting sessions to, and telling the operator
    // "this one is mid-erasure" invites them to try to keep it alive.
    if (error instanceof ConditionalCheckFailedException) return null;
    throw readFailure(error, MESSAGES.ADMIN_ACCESS_WRITE_FAILED);
  }

  return parseItem(UserProfileSchema, response.Attributes, PROFILE_CONTEXT);
}

// Two counters, deliberately separate, and the split is the fix for a real bug.
//
// The quota used to be claimed atomically at `POST /pre-interview` — at the moment
// a session was MINTED. So pressing "Build my interview" and closing the tab spent
// a slot before the plan had rendered and before anyone had spoken. What actually
// costs money is the Sonic stream, and a candidate who never answered a question
// never opened one worth billing.
//
// So:
//   recordSessionCreated — every mint. Display only; meters nothing.
//   claimInterviewSlot   — when the Sonic stream is about to open. Atomic, and
//                          the ONLY enforcement point. This is what the quota
//                          reads.
//   refundInterviewSlot  — undoes a claim for an interview that ended inside the
//                          refund window with nothing scoreable.
//
// The claim used to happen on the first scoreable answer, with the limit checked
// only at `POST /pre-interview`. That was a bypass, not a trade: the pre-flight
// read `sessionsConducted`, which nothing had moved yet, so a candidate at 0/3
// could mint fifty sessions and conduct all fifty — and an interview made only of
// "could you repeat that" was never charged at all. The charge now happens where
// the money is spent, and the pre-flight stays only as early, friendly UX.

// How many times a claim re-reads and retries after losing a compare-and-swap to
// a concurrent claim. Contention needs the same candidate opening several
// interviews in the same few milliseconds, so three is generous; running out is
// reported as a service failure rather than as an exhausted quota.
const CLAIM_MAX_ATTEMPTS = 3;

export type SlotClaim = {
  granted: boolean;
  // After the claim when granted, as read when refused — so the caller can
  // report either without a second read.
  allowance: SessionAllowance;
};

// Claims one interview against the candidate's quota, or refuses.
//
// A compare-and-swap, not a bare ADD: the limit lives in `resolveSessionAllowance`
// (three grant states, one default) and expressing all of that inside a DynamoDB
// condition would be a second, subtly different implementation of it. So the
// allowance is computed from a strongly consistent read, and the write is
// conditioned on the counter still holding the value that decision was made on.
// Two tabs claiming the last slot together both read 2/3; one write lands 3, the
// other fails its condition, re-reads 3/3 and is refused. Exactly one wins.
//
// Unlimited accounts still count — the admin table shows usage for them too —
// but their write carries no counter condition, since nothing is being guarded.
export async function claimInterviewSlot(args: {
  userId: string;
}): Promise<SlotClaim> {
  const TableName = requireTable();

  for (let attempt = 0; attempt < CLAIM_MAX_ATTEMPTS; attempt += 1) {
    const profile = await getProfile({ userId: args.userId });

    // The interview route only runs for a session minted from a complete
    // profile, so a missing one means it was erased in between.
    if (profile === null || profile.status === "deleting") {
      throw new ProfileStateError(MESSAGES.PROFILE_DELETING);
    }

    const allowance = resolveSessionAllowance({
      unlimitedAccess: profile.unlimitedAccess,
      sessionLimit: profile.sessionLimit,
      sessionsConducted: profile.sessionsConducted,
    });

    if (allowance.exhausted) return { granted: false, allowance };

    // The schema defaults an absent counter to 0, so an observed 0 may mean
    // "attribute missing" — both spellings must satisfy the guard.
    const condition = allowance.unlimited
      ? NOT_DELETING
      : `(${NOT_DELETING}) AND (attribute_not_exists(sessionsConducted) OR sessionsConducted = :observed)`;

    const values: Record<string, unknown> = {
      ":one": 1,
      ":now": new Date().toISOString(),
      ":deleting": "deleting",
    };
    if (!allowance.unlimited) values[":observed"] = profile.sessionsConducted;

    try {
      await dynamoClient.send(
        new UpdateCommand({
          TableName,
          Key: profileKey(args.userId),
          UpdateExpression: "SET updatedAt = :now ADD sessionsConducted :one",
          ConditionExpression: condition,
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: values,
          // Not ALL_NEW: nothing here needs the item back, and the profile
          // carries the resume text.
          ReturnValues: "NONE",
        }),
      );
    } catch (error) {
      // Lost the race, or the account started erasure. The re-read at the top
      // of the loop tells the two apart.
      if (error instanceof ConditionalCheckFailedException) continue;
      throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
    }

    return {
      granted: true,
      allowance: resolveSessionAllowance({
        unlimitedAccess: profile.unlimitedAccess,
        sessionLimit: profile.sessionLimit,
        sessionsConducted: profile.sessionsConducted + 1,
      }),
    };
  }

  throw new ServiceError(
    `${MESSAGES.PROFILE_SAVE_FAILED} — quota claim lost ${CLAIM_MAX_ATTEMPTS} races in a row`,
  );
}

// Gives back a slot `claimInterviewSlot` took. Called at most once per claim, by
// the connection that made it, which is what keeps the counter honest without
// a per-session marker in the condition.
//
// Floored at zero by the condition, so a refund can never make the counter
// negative even if something upstream calls it twice. Returns false rather than
// throwing when the condition fails — an account mid-erasure is not refunded,
// because its quota is about to stop existing.
export async function refundInterviewSlot(args: {
  userId: string;
}): Promise<boolean> {
  const TableName = requireTable();

  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName,
        Key: profileKey(args.userId),
        UpdateExpression: "SET updatedAt = :now ADD sessionsConducted :minusOne",
        ConditionExpression: `sessionsConducted > :zero AND (${NOT_DELETING})`,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":minusOne": -1,
          ":zero": 0,
          ":now": new Date().toISOString(),
          ":deleting": "deleting",
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
  }

  return true;
}

// Counts a session being minted. Display only.
//
// Unconditional beyond the erasure guard: this must never refuse, because it is
// not an enforcement point. A failure here costs a wrong number in the admin
// table, so the caller logs and continues rather than failing the request.
export async function recordSessionCreated(args: {
  userId: string;
}): Promise<void> {
  const TableName = requireTable();

  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName,
        Key: profileKey(args.userId),
        UpdateExpression: "SET updatedAt = :now ADD sessionsCreated :one",
        ConditionExpression: NOT_DELETING,
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":one": 1,
          ":now": new Date().toISOString(),
          ":deleting": "deleting",
        },
      }),
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return;
    throw readFailure(error, MESSAGES.PROFILE_SAVE_FAILED);
  }
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
      }),
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
          type: ITEM_TYPE.CACHED_PLAN,
          plan: args.plan,
          targetRole: args.targetRole,
          profileVersion: args.profileVersion,
          generatedAt: new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.PLAN_CACHE_SAVE_FAILED);
  }
}

// A cached coaching report, at USER#<uid> / COACH.
//
// Same machine as the plan cache: a DynamoDB item and a stamp compared on read.
// Two differences worth knowing before editing either:
//
//   1. Only the model's prose is stored. Every score, direction and priority is
//      recomputed per request from rows the handler had to read anyway.
//   2. A miss is cheap and a stale hit is not. A stale report tells a candidate
//      to study something they have already fixed, so the freshness check is
//      deliberately strict — any change to the inputs regenerates.
//
// No TTL, matching PROFILE and PLAN. This is account-scoped, and the stamp
// already expires it the moment the candidate's history changes.
export async function getCachedCoach(args: {
  userId: string;
}): Promise<CachedCoach | null> {
  const TableName = requireTable();

  let response;
  try {
    response = await dynamoClient.send(
      new GetCommand({
        TableName,
        Key: cachedCoachKey(args.userId),
        // A report written seconds ago by this candidate's previous request
        // must not be missed by an eventually-consistent read — that pays for a
        // second generation to produce the same prose.
        ConsistentRead: true,
      }),
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.COACH_CACHE_READ_FAILED);
  }

  if (response.Item === undefined) return null;

  return parseItem(CachedCoachSchema, response.Item, COACH_CONTEXT);
}

// Overwrites unconditionally — one report per user, newest wins.
//
// The caller passes the stamp it computed from the rows it actually read,
// before the Bedrock call rather than after. Recomputing here would pick up a
// summary attached while the model was running and mark prose that never saw it
// as fresh — the same trap `putCachedPlan` documents for `profileVersion`.
export async function putCachedCoach(args: {
  userId: string;
  prose: CoachProse;
  stamp: CoachCacheStamp;
}): Promise<void> {
  const TableName = requireTable();

  try {
    await dynamoClient.send(
      new PutCommand({
        TableName,
        Item: {
          ...cachedCoachKey(args.userId),
          type: ITEM_TYPE.CACHED_COACH,
          prose: args.prose,
          stamp: args.stamp,
          generatedAt: new Date().toISOString(),
        },
      }),
    );
  } catch (error) {
    throw readFailure(error, MESSAGES.COACH_CACHE_SAVE_FAILED);
  }
}
