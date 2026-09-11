import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  EvaluationResponseSchema,
  ITEM_TYPE,
  SORT_KEY,
  answerSk,
  evalSk,
  sessionPk,
} from "@repo/shared";
import { z } from "zod";
import type { MountedApp } from "../helpers/testApp";

const { sessionsRouter } = await import("../../routes/sessions");
const { MESSAGES } = await import("../../lib/messages");
const { mount } = await import("../helpers/testApp");

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = "prepilot-sessions-test";
const SESSION_ID = "01J000000000000000000000";
const USER = { id: "user-1", username: "tharun" };
const NOW = "2026-09-10T12:00:00.000Z";

// ULIDs sort by creation time, so these are already in the order asked.
const Q1 = "01M000000000000000000001";
const Q2 = "01M000000000000000000002";

const META = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.META,
  type: ITEM_TYPE.SESSION_META,
  sessionId: SESSION_ID,
  userId: USER.id,
  status: "evaluating",
  createdAt: NOW,
  role: "Backend Engineer",
};

const SUMMARY = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.EVAL_SUMMARY,
  type: ITEM_TYPE.SESSION_EVAL_SUMMARY,
  questionCount: 2,
};

function answer(questionId: string, overrides: Record<string, unknown> = {}) {
  return {
    PK: sessionPk(SESSION_ID),
    SK: answerSk(questionId),
    type: ITEM_TYPE.SESSION_ANSWER,
    questionId,
    questionText: `Question ${questionId}`,
    questionType: "technical",
    askedAt: NOW,
    transcript: `Answer to ${questionId}`,
    audioKey: null,
    durationMs: 42_000,
    interrupted: false,
    ...overrides,
  };
}

function evaluation(questionId: string, overrides: Record<string, unknown> = {}) {
  return {
    PK: sessionPk(SESSION_ID),
    SK: evalSk(questionId),
    type: ITEM_TYPE.SESSION_EVALUATION,
    questionId,
    correctness: 7,
    clarity: 6,
    depth: 5,
    rationale: "You named the tradeoff but did not point at a system you built.",
    modelId: "mistral.ministral-3-8b-instruct",
    evaluatedAt: NOW,
    ...overrides,
  };
}

// The two prefix queries are distinguished by their :prefix value, which is how
// one mocked QueryCommand serves both.
function partitionHolds(args: {
  meta?: Record<string, unknown>;
  summary?: Record<string, unknown>;
  answers?: Record<string, unknown>[];
  evaluations?: Record<string, unknown>[];
}) {
  const headers = [args.meta, args.summary].filter(
    (item): item is Record<string, unknown> => item !== undefined
  );
  ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: headers } });

  ddb.on(QueryCommand).callsFake((input) => ({
    Items:
      input.ExpressionAttributeValues?.[":prefix"] === "ANSWER#"
        ? (args.answers ?? [])
        : (args.evaluations ?? []),
  }));
}

const ErrorBody = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

let app: MountedApp | undefined;

async function start(user: { id: string; username: string } | null = USER) {
  app = await mount({ path: "/api/v1/sessions", router: sessionsRouter, user });
  return app;
}

async function getEvaluation(url: string, sessionId = SESSION_ID) {
  return fetch(`${url}/api/v1/sessions/${sessionId}/evaluation`);
}

beforeEach(() => ddb.reset());

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

afterAll(() => ddb.restore());

describe("GET /api/v1/sessions/:sessionId/evaluation", () => {
  it("returns each scored answer with the question it answered", async () => {
    partitionHolds({
      meta: META,
      summary: SUMMARY,
      answers: [answer(Q1), answer(Q2)],
      evaluations: [evaluation(Q1), evaluation(Q2)],
    });
    const { url } = await start();

    const response = await getEvaluation(url);
    const body = EvaluationResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.completed).toBe(2);
    expect(body.total).toBe(2);
    expect(body.evaluations[0]?.questionText).toBe(`Question ${Q1}`);
    expect(body.evaluations[0]?.transcript).toBe(`Answer to ${Q1}`);
    expect(body.evaluations[0]?.correctness).toBe(7);
  });

  // The frontend contract is that a candidate is talking to "the interviewer",
  // never to a named service — and exposing it would invite comparing scores
  // across models, which is the comparison the attribute exists to warn
  // engineers about.
  it("never exposes which model produced a score", async () => {
    partitionHolds({
      meta: META,
      summary: SUMMARY,
      answers: [answer(Q1)],
      evaluations: [evaluation(Q1)],
    });
    const { url } = await start();

    const raw = await (await getEvaluation(url)).text();

    expect(raw).not.toContain("modelId");
    expect(raw).not.toContain("ministral");
  });

  // Partial results as they land. A candidate reads the first score while the
  // rest are queued — the whole point of scoring asynchronously.
  it("returns what has landed while the rest are still queued", async () => {
    partitionHolds({
      meta: META,
      summary: SUMMARY,
      answers: [answer(Q1), answer(Q2)],
      evaluations: [evaluation(Q1)],
    });
    const { url } = await start();

    const body = EvaluationResponseSchema.parse(
      await (await getEvaluation(url)).json()
    );

    expect(body.status).toBe("evaluating");
    expect(body.completed).toBe(1);
    expect(body.total).toBe(2);
    expect(body.averages).toBeUndefined();
  });

  // Averages appearing is the signal the round is finished — the client stops
  // polling on that rather than on a count.
  it("carries the averages and a complete status once finished", async () => {
    partitionHolds({
      meta: { ...META, status: "complete" },
      summary: { ...SUMMARY, averages: { correctness: 7, clarity: 6, depth: 5 } },
      answers: [answer(Q1), answer(Q2)],
      evaluations: [evaluation(Q1), evaluation(Q2)],
    });
    const { url } = await start();

    const body = EvaluationResponseSchema.parse(
      await (await getEvaluation(url)).json()
    );

    expect(body.status).toBe("complete");
    expect(body.averages).toEqual({ correctness: 7, clarity: 6, depth: 5 });
  });

  it("orders answers as they were asked", async () => {
    partitionHolds({
      meta: META,
      summary: SUMMARY,
      answers: [answer(Q2), answer(Q1)],
      evaluations: [evaluation(Q2), evaluation(Q1)],
    });
    const { url } = await start();

    const body = EvaluationResponseSchema.parse(
      await (await getEvaluation(url)).json()
    );

    expect(body.evaluations.map((item) => item.questionId)).toEqual([Q1, Q2]);
  });

  // A score on a half-heard question needs its context, or it reads as an
  // unexplained penalty.
  it("reports that an answer was given over an interrupted question", async () => {
    partitionHolds({
      meta: META,
      summary: SUMMARY,
      answers: [answer(Q1, { interrupted: true })],
      evaluations: [evaluation(Q1)],
    });
    const { url } = await start();

    const body = EvaluationResponseSchema.parse(
      await (await getEvaluation(url)).json()
    );

    expect(body.evaluations[0]?.interrupted).toBe(true);
  });

  // A whole-partition Query would also return INPUTS, which carries the full
  // resume text. Reading only what is displayed keeps that impossible rather
  // than merely unused.
  it("never reads the session's INPUTS item", async () => {
    partitionHolds({
      meta: META,
      summary: SUMMARY,
      answers: [answer(Q1)],
      evaluations: [evaluation(Q1)],
    });
    const { url } = await start();

    await getEvaluation(url);

    const prefixes = ddb
      .commandCalls(QueryCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[":prefix"]);
    expect(prefixes.sort()).toEqual(["ANSWER#", "EVAL#"]);

    const keys =
      ddb.commandCalls(BatchGetCommand)[0]?.args[0].input.RequestItems?.[TABLE]
        ?.Keys ?? [];
    expect(keys.map((key) => key.SK)).toEqual([
      SORT_KEY.META,
      SORT_KEY.EVAL_SUMMARY,
    ]);
  });

  // Nothing to wait for, and a spinner that never resolves is worse than an
  // empty state.
  it("reports a finished round of zero when there is no rollup", async () => {
    partitionHolds({ meta: META, answers: [], evaluations: [] });
    const { url } = await start();

    const body = EvaluationResponseSchema.parse(
      await (await getEvaluation(url)).json()
    );

    expect(body.completed).toBe(0);
    expect(body.total).toBe(0);
  });
});

describe("access control", () => {
  it("401s a request carrying no user", async () => {
    const { url } = await start(null);

    expect((await getEvaluation(url)).status).toBe(401);
  });

  it("404s someone else's session", async () => {
    partitionHolds({
      meta: { ...META, userId: "someone-else" },
      summary: SUMMARY,
      answers: [answer(Q1)],
      evaluations: [evaluation(Q1)],
    });
    const { url } = await start();

    const response = await getEvaluation(url);

    expect(response.status).toBe(404);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.SESSION_NOT_FOUND
    );
  });

  // The status must not confirm that an id exists.
  it("gives a missing session the identical response", async () => {
    partitionHolds({ answers: [], evaluations: [] });
    const { url } = await start();

    const response = await getEvaluation(url);

    expect(response.status).toBe(404);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.SESSION_NOT_FOUND
    );
  });

  it("does not leak a DynamoDB failure to the client", async () => {
    ddb.on(BatchGetCommand).rejects(new Error("ResourceNotFoundException: table x"));
    const { url } = await start();

    const response = await getEvaluation(url);
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain("ResourceNotFoundException");
    expect(ErrorBody.parse(JSON.parse(raw)).message).toBe(
      MESSAGES.SESSION_UNAVAILABLE
    );
  });
});
