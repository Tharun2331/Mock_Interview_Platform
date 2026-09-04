import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  PutCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
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
}): Promise<void> {
  const TableName = requireTable();
  const createdAt = new Date().toISOString();

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
                sessionId: args.sessionId,
                userId: args.userId,
                status: "planning",
                createdAt,
                resumeKey: args.resumeKey,
                // Undefined is stripped by the document client's
                // removeUndefinedValues, so an omitted profile leaves the
                // attribute absent rather than present-and-null.
                githubUsername: args.githubUsername ?? undefined,
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
}): Promise<Pick<PlannerInput, "repos" | "resumeText">> {
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

// Terminal state for the session. Separate from recordAnswer so a failure to
// mark completion never costs an answer that was already written.
export async function finishInterview(args: {
  sessionId: string;
  status: "complete" | "failed";
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
