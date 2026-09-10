import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ITEM_TYPE,
  KEY_PREFIX,
  PLAN_LIMITS,
  SORT_KEY,
  answerSk,
  SessionInputsSchema,
  SessionMetaSchema,
  sessionPk,
  sessionSk,
  userPk,
  type PlannerInput,
  type PlanResponse,
  type PreInterviewRepo,
  type QuestionType,
  type SessionMeta,
  type SessionStatus,
} from "@repo/shared";
import { SECONDS_PER_DAY, SESSION_RETENTION } from "./constants";
import { dynamoClient, parseItem, requireTable } from "./dynamo";
import { ServiceError, SessionAccessError, SessionStateError } from "./errors";
import { MESSAGES } from "./messages";

// Every DynamoDB command for the session lifecycle lives here rather than in
// the routes, matching how lib/s3.ts owns the object writes. The routes decide
// status codes; this module decides key layout.

// Statuses from which a plan may still be written. Once the interview is under
// way its answers are recorded against a specific set of focus areas, so
// swapping the plan would leave the Evaluator scoring against one that never
// ran. Shared by the pre-flight read and the write's condition expression so
// the two cannot disagree about what "too late" means.
const REPLANNABLE_STATUSES: SessionStatus[] = ["planning", "ready"];

// BatchWriteItem's hard cap. Not a tuning value — sending 26 is a validation
// error, not a slower request.
const DELETE_BATCH_SIZE = 25;

// Retries for items DynamoDB hands back as unprocessed. Three is enough to ride
// out throttling on a table this size; past that the sweep should stop and leave
// its marker rather than spin.
const DELETE_MAX_ATTEMPTS = 3;

// The one place a session's expiry is computed, so META, INPUTS, every ANSWER
// and the user's lookup ref all expire at the same instant. Derived per-item
// from "now" instead, a session written across an hour would have its parts
// disappear across an hour — leaving a transcript whose META is already gone.
//
// Whether the value is honoured is an environment decision, not a code one:
// DynamoDB ignores the attribute unless the table has TTL enabled on it. The
// dev table does; prod deliberately does not, because there session data is the
// product rather than a fixture. Writing it unconditionally means enabling
// retention later is a Terraform change with no deploy behind it.
export function sessionExpiresAt(): number {
  return (
    Math.floor(Date.now() / 1000) + SESSION_RETENTION.DAYS * SECONDS_PER_DAY
  );
}

// Creates the session the moment its inputs exist — before any Bedrock call, so
// an uploaded resume is never lost to a Planner failure.
//
// One transaction rather than two writes. The failure they prevent is not
// symmetric: a META item without its history entry is merely invisible on the
// history page, while a history entry pointing at a META item that was never
// written is a row that 404s when clicked. Transactions cost double the write
// units, which on two small items once per session is not a number worth
// optimising against.
export async function createSession(args: {
  sessionId: string;
  userId: string;
  resumeKey: string;
  githubUsername: string | null;
  repos: PreInterviewRepo[];
  resumeText: string;
  profileVersion: number;
}): Promise<void> {
  const TableName = requireTable();
  const createdAt = new Date().toISOString();
  // Computed once for all three items, so the parts of one session cannot
  // expire at different moments.
  const expiresAt = sessionExpiresAt();

  try {
    await dynamoClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName,
              Item: {
                PK: sessionPk(args.sessionId),
                SK: SORT_KEY.META,
                type: ITEM_TYPE.SESSION_META,
                expiresAt,
                sessionId: args.sessionId,
                userId: args.userId,
                status: "planning",
                createdAt,
                resumeKey: args.resumeKey,
                // Undefined is stripped by the document client's
                // removeUndefinedValues, so an omitted profile leaves the
                // attribute absent rather than present-and-null.
                githubUsername: args.githubUsername ?? undefined,
                // The snapshot marker. INPUTS below is a copy of the profile's
                // material as it stood right now, and this records which
                // version that was.
                profileVersion: args.profileVersion,
              },
              // ULID collision is not a realistic failure, but a silent
              // overwrite of somebody's session is bad enough that the guard is
              // worth one condition expression.
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Put: {
              TableName,
              Item: {
                PK: sessionPk(args.sessionId),
                SK: SORT_KEY.INPUTS,
                type: ITEM_TYPE.SESSION_INPUTS,
                expiresAt,
                // Capped on the way in. Both bounds come from the shared schema
                // this item is validated against on read, so a stored item can
                // never be too large for its own validator to accept.
                repos: args.repos.slice(0, PLAN_LIMITS.MAX_REPOS),
                resumeText: args.resumeText.slice(
                  0,
                  PLAN_LIMITS.MAX_RESUME_CHARS
                ),
                resumeKey: args.resumeKey,
              },
            },
          },
          {
            Put: {
              TableName,
              Item: {
                PK: userPk(args.userId),
                SK: sessionSk(args.sessionId),
                type: ITEM_TYPE.USER_SESSION_REF,
                // The ref expires with the session it points at. Without this
                // it would outlive it and the history page would list an
                // interview whose every item is gone.
                expiresAt,
                sessionId: args.sessionId,
                userId: args.userId,
                createdAt,
              },
            },
          },
        ],
      })
    );
  } catch (error) {
    if (error instanceof TransactionCanceledException) {
      throw new ServiceError(
        `${MESSAGES.SESSION_CREATE_FAILED} — ${
          error.CancellationReasons?.map((reason) => reason.Code).join(", ") ??
          "unknown"
        }`
      );
    }
    throw new ServiceError(
      `${MESSAGES.SESSION_CREATE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }
}

// Every session id a candidate owns, for the erasure sweep.
//
// `begins_with(SK, "SESSION#")` is not optional. The USER#<uid> partition also
// holds PROFILE and PLAN, both of which sort before "SESSION#" — an unfiltered
// Query would return them here and this would try to delete a session whose id
// is undefined.
//
// Paginated properly rather than trusting one page: a candidate with enough
// history to exceed 1 MB of refs is exactly the one whose leftovers would go
// unnoticed.
export async function listUserSessionIds(args: {
  userId: string;
}): Promise<string[]> {
  const TableName = requireTable();
  const ids: string[] = [];
  let cursor: Record<string, unknown> | undefined;

  do {
    let response;
    try {
      response = await dynamoClient.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "PK = :pk AND begins_with(SK, :prefix)",
          ExpressionAttributeValues: {
            ":pk": userPk(args.userId),
            ":prefix": KEY_PREFIX.SESSION,
          },
          // Only the id is needed. Projecting the whole ref item would read
          // attributes this never looks at, on every page.
          ProjectionExpression: "sessionId",
          ExclusiveStartKey: cursor,
        })
      );
    } catch (error) {
      throw new ServiceError(
        `${MESSAGES.SESSION_READ_FAILED} — ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    for (const item of response.Items ?? []) {
      if (typeof item.sessionId === "string") ids.push(item.sessionId);
    }

    cursor = response.LastEvaluatedKey;
  } while (cursor !== undefined);

  return ids;
}

// Deletes every item under one session — META, INPUTS, each ANSWER and EVAL,
// the eval summary and the coach plan — without needing to know which of them
// exist. The partition is queried for its keys and whatever comes back is
// deleted, so a session that never got past `planning` and one that ran to
// completion take the same path.
//
// Deliberately not conditioned on ownership. The only caller has already proved
// it by finding this id in the candidate's own USER#<uid> partition, and a
// condition here would make the delete non-idempotent for no gain.
export async function deleteSessionData(args: {
  sessionId: string;
}): Promise<number> {
  const TableName = requireTable();
  const pk = sessionPk(args.sessionId);
  let deleted = 0;
  let cursor: Record<string, unknown> | undefined;

  do {
    let response;
    try {
      response = await dynamoClient.send(
        new QueryCommand({
          TableName,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": pk },
          // Keys only — a transcript can be large and none of it is read here.
          ProjectionExpression: "PK, SK",
          ExclusiveStartKey: cursor,
        })
      );
    } catch (error) {
      throw new ServiceError(
        `${MESSAGES.SESSION_READ_FAILED} — ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    const keys = (response.Items ?? []).filter(
      (item) => typeof item.PK === "string" && typeof item.SK === "string"
    );

    // BatchWriteItem caps at 25 per call.
    for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
      const chunk = keys.slice(start, start + DELETE_BATCH_SIZE);
      await deleteKeyChunk(TableName, chunk);
      deleted += chunk.length;
    }

    cursor = response.LastEvaluatedKey;
  } while (cursor !== undefined);

  return deleted;
}

// Removes the USER#<uid>/SESSION#<sid> lookup items.
//
// Easy to miss, and its own function so it cannot be: these refs live in the
// *user's* partition, not the session's, so deleteSessionData never sees them.
// Left behind they are invisible — nothing reads a ref whose session is gone —
// and an erasure that leaves rows keyed to a deleted user behind is exactly the
// thing erasure was supposed to prevent.
export async function deleteUserSessionRefs(args: {
  userId: string;
  sessionIds: string[];
}): Promise<number> {
  const TableName = requireTable();
  const pk = userPk(args.userId);
  const keys = args.sessionIds.map((sessionId) => ({
    PK: pk,
    SK: sessionSk(sessionId),
  }));

  for (let start = 0; start < keys.length; start += DELETE_BATCH_SIZE) {
    await deleteKeyChunk(TableName, keys.slice(start, start + DELETE_BATCH_SIZE));
  }

  return keys.length;
}

// BatchWriteItem reports per-item throttling as UnprocessedItems rather than as
// an error, so a batch can "succeed" having written nothing. Left unretried,
// that is how a deletion silently leaves data behind.
async function deleteKeyChunk(
  TableName: string,
  keys: Record<string, unknown>[]
): Promise<void> {
  let pending = keys.map((Key) => ({ DeleteRequest: { Key } }));

  for (let attempt = 0; attempt < DELETE_MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await dynamoClient.send(
        new BatchWriteCommand({ RequestItems: { [TableName]: pending } })
      );
    } catch (error) {
      throw new ServiceError(
        `${MESSAGES.SESSION_DELETE_FAILED} — ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    const unprocessed = response.UnprocessedItems?.[TableName] ?? [];
    if (unprocessed.length === 0) return;

    pending = unprocessed.flatMap((request) =>
      request.DeleteRequest === undefined
        ? []
        : [{ DeleteRequest: { Key: request.DeleteRequest.Key ?? {} } }]
    );
  }

  // Throwing leaves the profile's `deleting` marker in place, which is what
  // makes the sweep resumable — every delete in it is idempotent, so a retry
  // simply finishes the job.
  throw new ServiceError(MESSAGES.SESSION_DELETE_INCOMPLETE);
}

// Loads the candidate material the Planner reads, proving ownership on the way.
//
// One BatchGetItem rather than two GetItems: META carries the owner and INPUTS
// carries the material, and the route needs both before it can call Bedrock. A
// Query on the partition would also return both, but it would return every
// answer and evaluation too once the interview has run.
// Everything the Planner needs except the target role, which comes from the
// request rather than the session — the candidate chooses it at plan time.
export async function loadPlannerInputs(args: {
  sessionId: string;
  userId: string;
}): Promise<
  Pick<PlannerInput, "repos" | "resumeText"> & { profileVersion?: number }
> {
  const TableName = requireTable();
  const pk = sessionPk(args.sessionId);

  let response;
  try {
    response = await dynamoClient.send(
      new BatchGetCommand({
        RequestItems: {
          [TableName]: {
            Keys: [
              { PK: pk, SK: SORT_KEY.META },
              { PK: pk, SK: SORT_KEY.INPUTS },
            ],
            // Strongly consistent. A candidate can submit the form and reach
            // the plan step in well under a second, and an eventually
            // consistent read here would intermittently report the session they
            // just created as missing.
            ConsistentRead: true,
          },
        },
      })
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.SESSION_READ_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  // BatchGetItem returns matches unordered and simply omits misses, so the
  // items are found by their sort key rather than by position.
  const items = response.Responses?.[TableName] ?? [];
  const metaItem = items.find((item) => item.SK === SORT_KEY.META);
  const inputsItem = items.find((item) => item.SK === SORT_KEY.INPUTS);

  // Same error for "no such session" and "not yours", for the same reason as
  // attachPlan: the response must not confirm that a session id exists.
  if (metaItem === undefined || metaItem.userId !== args.userId) {
    throw new SessionAccessError(MESSAGES.SESSION_NOT_FOUND);
  }

  const inputs = parseItem(SessionInputsSchema, inputsItem, "INPUTS");
  const meta = parseItem(SessionMetaSchema, metaItem, "META");

  // Already interviewing or later. Re-planning would swap the focus areas and
  // questionCount out from under a session that has answers recorded against
  // the old ones, leaving the Evaluator scoring against a plan that never ran.
  //
  // Checked here to fail before spending a Bedrock call, and again as a
  // condition on the write in attachPlan — between this read and that write the
  // candidate could start the interview from another tab, and only the
  // condition expression closes that window.
  if (!REPLANNABLE_STATUSES.includes(meta.status)) {
    throw new SessionStateError(MESSAGES.SESSION_ALREADY_STARTED);
  }

  return {
    repos: inputs.repos,
    // An empty extraction is a real outcome — a scanned resume — and the
    // Planner treats absent and empty the same way.
    resumeText: inputs.resumeText.length > 0 ? inputs.resumeText : undefined,
    // Returned alongside the material rather than read separately, because it
    // describes exactly this material. The plan cache is checked against it.
    profileVersion: meta.profileVersion,
  };
}

// Writes one completed exchange. Called as the interview runs, never batched to
// the end: a session that drops mid-way must keep everything said before it,
// and the whole point of DynamoDB here is that the Evaluator's only input is
// this transcript.
//
// Deliberately not conditioned on anything. A late or duplicate write is far
// better than a lost answer, and PutItem keyed by questionId is idempotent, so
// a retry overwrites rather than duplicating.
export async function recordAnswer(args: {
  sessionId: string;
  questionId: string;
  questionText: string;
  questionType: QuestionType;
  transcript: string;
  askedAt: string;
  durationMs: number;
  interrupted: boolean;
}): Promise<void> {
  await dynamoClient.send(
    new PutCommand({
      TableName: requireTable(),
      Item: {
        PK: sessionPk(args.sessionId),
        SK: answerSk(args.questionId),
        type: ITEM_TYPE.SESSION_ANSWER,
        // Recomputed rather than read from META: that would cost a read on
        // every turn of a live interview to save a few hours of drift on an
        // expiry measured in months.
        expiresAt: sessionExpiresAt(),
        questionId: args.questionId,
        questionText: args.questionText,
        questionType: args.questionType,
        askedAt: args.askedAt,
        transcript: args.transcript,
        // Best-effort and not wired yet — the audio upload path is Phase 5.
        audioKey: null,
        durationMs: args.durationMs,
        interrupted: args.interrupted,
      },
    })
  );
}

// Moves the session out of `in_progress`. Separate from recordAnswer so a
// failure to mark completion never costs an answer that was already written.
//
// `evaluating` is the normal outcome, not `complete`: the answers have been
// recorded but nothing has scored them yet. Marking a session complete here
// would tell the results page that feedback is ready when the queue has not
// been drained, and there would be no later transition to correct it. Only an
// interview that produced nothing to score finishes complete, because for that
// session there genuinely is nothing left to wait for.
export async function finishInterview(args: {
  sessionId: string;
  status: "evaluating" | "complete" | "failed";
}): Promise<void> {
  await dynamoClient.send(
    new UpdateCommand({
      TableName: requireTable(),
      Key: { PK: sessionPk(args.sessionId), SK: SORT_KEY.META },
      UpdateExpression: "SET #status = :status",
      // Only from in_progress, so a late close cannot drag a session that has
      // already moved on to evaluating back to complete.
      ConditionExpression: "#status = :inProgress",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": args.status,
        ":inProgress": "in_progress",
      },
    })
  );
}

// The last transition: every answer has been scored, so the session leaves
// `evaluating`.
//
// Conditioned on `evaluating` rather than written blind. Two workers can finish
// their final message within milliseconds of each other, and both will see the
// count reach its target — this makes the second one a no-op instead of a
// second completion. It also means a retried message cannot drag a session
// that has since moved on back to `complete`.
//
// Returns false when the condition failed, which is not an error: it means
// somebody else got there first, or the session was never in `evaluating` to
// begin with.
export async function completeEvaluation(args: {
  sessionId: string;
}): Promise<boolean> {
  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: requireTable(),
        Key: { PK: sessionPk(args.sessionId), SK: SORT_KEY.META },
        UpdateExpression: "SET #status = :complete",
        ConditionExpression: "#status = :evaluating",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":complete": "complete",
          ":evaluating": "evaluating",
        },
      })
    );
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return false;
    throw new ServiceError(
      `${MESSAGES.SESSION_UPDATE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  return true;
}

// Loads a session for the live interview and moves it to `in_progress`.
//
// The status change is a conditional update rather than a read-then-write: it
// is what stops two browser tabs opening two Sonic streams against one session,
// which would bill twice and interleave two conversations into one transcript.
export async function startInterview(args: {
  sessionId: string;
  userId: string;
}): Promise<SessionMeta> {
  try {
    const response = await dynamoClient.send(
      new UpdateCommand({
        TableName: requireTable(),
        Key: { PK: sessionPk(args.sessionId), SK: SORT_KEY.META },
        UpdateExpression: "SET #status = :inProgress",
        // `ready` only. A session still `planning` has no plan to interview
        // against, and one already `in_progress` is being held by another
        // connection.
        ConditionExpression:
          "attribute_exists(PK) AND userId = :userId AND #status = :ready",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: {
          ":inProgress": "in_progress",
          ":ready": "ready",
          ":userId": args.userId,
        },
        // Returns the whole item so the caller gets the plan without a second
        // read — the plan is needed immediately to build the system prompt.
        ReturnValues: "ALL_NEW",
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );

    return parseItem(SessionMetaSchema, response.Attributes, "META");
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) {
      const owner = error.Item?.userId?.S;
      if (owner === args.userId) {
        throw new SessionStateError(MESSAGES.SESSION_NOT_INTERVIEWABLE);
      }
      throw new SessionAccessError(MESSAGES.SESSION_NOT_FOUND);
    }
    throw new ServiceError(
      `${MESSAGES.SESSION_UPDATE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }
}

// Attaches the Planner's output and moves the session to `ready`.
//
// `questionCount` is derived here rather than trusted from the client: it is
// the denominator the Evaluator uses to decide the interview is complete, so a
// wrong value would either fire the Coach early or never fire it at all.
export async function attachPlan(args: {
  sessionId: string;
  userId: string;
  targetRole: string;
  plan: PlanResponse;
}): Promise<void> {
  const questionCount =
    args.plan.questionMix.behavioural +
    args.plan.questionMix.technical +
    args.plan.questionMix.roleSpecific;

  try {
    await dynamoClient.send(
      new UpdateCommand({
        TableName: requireTable(),
        Key: { PK: sessionPk(args.sessionId), SK: SORT_KEY.META },
        UpdateExpression:
          "SET #plan = :plan, #role = :role, #status = :status, questionCount = :questionCount",
        // The ownership check. Without `userId = :userId` any authenticated
        // caller could write a plan into any session id they guessed or saw.
        // attribute_exists pins it to a session that was actually created,
        // rather than conjuring a META item with no history entry.
        //
        // The status clause repeats loadPlannerInputs' check, deliberately. That
        // one runs before the Bedrock call so a doomed request fails cheaply;
        // this one is atomic with the write, and is what actually prevents a
        // plan landing on an interview that started while the model was
        // thinking — a window of several seconds.
        ConditionExpression:
          "attribute_exists(PK) AND userId = :userId AND #status IN (:planning, :ready)",
        ExpressionAttributeNames: {
          // All three are DynamoDB reserved words.
          "#plan": "plan",
          "#role": "role",
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":plan": args.plan,
          ":role": args.targetRole,
          ":status": "ready",
          ":questionCount": questionCount,
          ":userId": args.userId,
          ":planning": REPLANNABLE_STATUSES[0],
          ":ready": REPLANNABLE_STATUSES[1],
        },
        // Returns the item on the exception when the condition fails, which is
        // the only way to tell the two failure causes apart — wrong owner and
        // wrong status both surface as the same ConditionalCheckFailed
        // otherwise, and they deserve different responses. Costs nothing on the
        // success path.
        ReturnValuesOnConditionCheckFailure: "ALL_OLD",
      })
    );
  } catch (error) {
    // Missing session and someone else's session are deliberately the same
    // error. Distinguishing them would confirm that a given session id exists,
    // which is an enumeration oracle for no benefit — a caller who owns the
    // session never sees this path.
    if (error instanceof ConditionalCheckFailedException) {
      // The returned item is raw AttributeValue, not document-client shaped —
      // the exception comes from the low-level client, below the marshaller.
      const owner = error.Item?.userId?.S;

      // The caller owns it, so the clause that failed was the status one: the
      // interview started while the Planner was running. Ownership is proven,
      // so this can say what actually happened.
      if (owner === args.userId) {
        throw new SessionStateError(MESSAGES.SESSION_ALREADY_STARTED);
      }

      // Missing session and someone else's session stay indistinguishable.
      // Separating them would confirm that a given session id exists, which is
      // an enumeration oracle for no benefit — a caller who owns the session
      // never reaches this branch.
      throw new SessionAccessError(MESSAGES.SESSION_NOT_FOUND);
    }
    throw new ServiceError(
      `${MESSAGES.SESSION_UPDATE_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }
}
