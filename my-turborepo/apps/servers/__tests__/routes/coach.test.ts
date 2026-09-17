import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { CoachReportSchema, ITEM_TYPE, userPk } from "@repo/shared";
import { z } from "zod";
import {
  resetStructuredStub,
  setStructuredReplies,
} from "../helpers/bedrockStub";
import type { MountedApp } from "../helpers/testApp";

const { coachRouter } = await import("../../routes/coach");
const { MESSAGES } = await import("../../lib/messages");
const { mount } = await import("../helpers/testApp");

const ddb = mockClient(DynamoDBDocumentClient);

const USER = { id: "user-1", username: "tharun" };

function summaryRow(overrides: Record<string, unknown> = {}) {
  return {
    PK: userPk(USER.id),
    SK: "SUMMARY#2026-09-01T10:00:00.000Z",
    type: ITEM_TYPE.USER_SESSION_SUMMARY,
    sessionId: "01J000000000000000000001",
    completedAt: "2026-09-01T10:00:00.000Z",
    role: "Backend Engineer",
    overallScore: 5,
    topStrength: "correctness",
    topWeakness: "depth",
    questionCount: 8,
    ...overrides,
  };
}

const ErrorBody = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

let app: MountedApp | undefined;

async function start(user: { id: string; username: string } | null = USER) {
  app = await mount({ path: "/api/v1/coach", router: coachRouter, user });
  return app;
}

beforeEach(() => {
  ddb.reset();
  resetStructuredStub();
  setStructuredReplies([
    {
      topics: [
        {
          topic: "Backend Engineer",
          summary: "You are steadying out.",
          focusPoints: ["Name the tradeoff first."],
        },
      ],
    },
  ]);
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

afterAll(() => ddb.restore());

describe("GET /api/v1/coach", () => {
  it("returns a report built from the candidate's own history", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [
        summaryRow({ overallScore: 3, SK: "SUMMARY#2026-09-01T10:00:00.000Z" }),
        summaryRow({
          overallScore: 8,
          completedAt: "2026-09-10T10:00:00.000Z",
          SK: "SUMMARY#2026-09-10T10:00:00.000Z",
        }),
      ],
    });
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/coach`);
    const report = CoachReportSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(report.trends[0]?.direction).toBe("improving");
    expect(report.roadmap[0]?.topic).toBe("Backend Engineer");
  });

  // One Query, not one per session. Evaluations live under SESSION#<sid> with
  // nothing naming a user, so reading them per session is the fan-out these
  // denormalised rows exist to avoid — and a second Query here would be the
  // first step back toward it.
  it("reads the history in a single query", async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryRow()] });
    const { url } = await start();

    await fetch(`${url}/api/v1/coach`);

    expect(ddb.commandCalls(QueryCommand)).toHaveLength(1);
  });

  // The USER partition also holds PROFILE and PLAN, both of which sort before
  // "SUMMARY#". An unfiltered Query would hand those back as summaries.
  it("filters to summary rows rather than reading the whole partition", async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryRow()] });
    const { url } = await start();

    await fetch(`${url}/api/v1/coach`);

    const input = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.KeyConditionExpression).toContain("begins_with");
  });

  // A candidate who has finished nothing is not an error — they simply have
  // not done an interview yet, and the page has an empty state for it.
  it("returns an empty report for a candidate with no history", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/coach`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ trends: [], roadmap: [] });
  });

  it("401s a request carrying no user", async () => {
    const { url } = await start(null);

    expect((await fetch(`${url}/api/v1/coach`)).status).toBe(401);
  });

  // Scoped by the token, never by anything in the request — there is no id in
  // the path that could name somebody else's history.
  it("queries only the authenticated user's partition", async () => {
    ddb.on(QueryCommand).resolves({ Items: [summaryRow()] });
    const { url } = await start();

    await fetch(`${url}/api/v1/coach`);

    const input = ddb.commandCalls(QueryCommand)[0]?.args[0].input;
    expect(input?.ExpressionAttributeValues?.[":pk"]).toBe(userPk(USER.id));
  });

  it("500s a failed read without leaking the cause", async () => {
    ddb.on(QueryCommand).rejects(new Error("ProvisionedThroughputExceeded on table x"));
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/coach`);
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain("ProvisionedThroughput");
    expect(raw).not.toContain("table x");
    expect(ErrorBody.parse(JSON.parse(raw)).message).toBe(
      MESSAGES.SESSION_UNAVAILABLE
    );
  });

  // A row that no longer matches its schema is skipped rather than failing the
  // whole report — one unreadable interview costs a candidate one data point,
  // an exception costs them the page.
  it("skips an unparseable row rather than failing the report", async () => {
    ddb.on(QueryCommand).resolves({
      Items: [summaryRow(), { PK: userPk(USER.id), SK: "SUMMARY#broken" }],
    });
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/coach`);

    expect(response.status).toBe(200);
    // Two items for the one readable row — one per track — rather than one per
    // session. The broken row contributes nothing and does not fail the rest.
    const report = CoachReportSchema.parse(await response.json());
    expect(report.roadmap).toHaveLength(2);
    expect(new Set(report.roadmap.map((item) => item.topic)).size).toBe(1);
  });
});
