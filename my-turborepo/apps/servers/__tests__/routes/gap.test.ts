import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  GapAnalysisSchema,
  ITEM_TYPE,
  SORT_KEY,
  sessionPk,
} from "@repo/shared";
import { z } from "zod";
import {
  resetStructuredStub,
  setStructuredFailure,
  setStructuredReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";
import type { MountedApp } from "../helpers/testApp";

const { gapRouter, summariseRepos } = await import("../../routes/gap");
const { MESSAGES } = await import("../../lib/messages");
const { mount } = await import("../helpers/testApp");
const { BedrockError } = await import("../../lib/errors");

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = "prepilot-sessions-test";
const SESSION_ID = "01J000000000000000000000";
const USER = { id: "user-1", username: "tharun" };
const NOW = "2026-09-12T10:00:00.000Z";

const META = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.META,
  type: ITEM_TYPE.SESSION_META,
  sessionId: SESSION_ID,
  userId: USER.id,
  status: "ready",
  createdAt: NOW,
  profileVersion: 3,
};

const INPUTS = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.INPUTS,
  type: ITEM_TYPE.SESSION_INPUTS,
  repos: [
    {
      description: "Kafka consumers",
      name: "order-service",
      fullName: "u/order-service",
      starCount: 42,
    },
  ],
  resumeText: "Three years of React and Node at EY.",
  resumeKey: "resumes/user-1/resume.pdf",
};

const REQUIREMENTS = [
  { requirement: "Kubernetes", bucket: "none", evidence: "not mentioned" },
  {
    requirement: "Kafka",
    bucket: "strong",
    evidence: "order-service consumers",
  },
];

const ErrorBody = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

function sessionFound(meta: Record<string, unknown> = META) {
  ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [meta, INPUTS] } });
}

let app: MountedApp | undefined;

async function start(user: { id: string; username: string } | null = USER) {
  app = await mount({ path: "/api/v1/gap", router: gapRouter, user });
  return app;
}

async function postGap(url: string, body: unknown) {
  return fetch(`${url}/api/v1/gap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = {
  sessionId: SESSION_ID,
  jobDescription: "We need Kubernetes and Kafka experience.",
};

beforeEach(() => {
  ddb.reset();
  resetStructuredStub();
  setStructuredReplies([{ requirements: REQUIREMENTS }]);
  ddb.on(PutCommand).resolves({});
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

afterAll(() => ddb.restore());

describe("POST /api/v1/gap", () => {
  it("analyses the posting and returns the buckets", async () => {
    sessionFound();
    const { url } = await start();

    const response = await postGap(url, BODY);
    const analysis = GapAnalysisSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(analysis.requirements).toHaveLength(2);
    expect(analysis.sessionId).toBe(SESSION_ID);
  });

  // Stored so the interview can be resumed, or its stream renewed, without
  // paying for the analysis again.
  it("persists it against the session", async () => {
    sessionFound();
    const { url } = await start();

    await postGap(url, BODY);

    const item = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item?.PK).toBe(sessionPk(SESSION_ID));
    expect(item?.SK).toBe(SORT_KEY.GAP);
    // Every session-scoped item carries one, or it outlives the session.
    expect(item?.expiresAt).toBeGreaterThan(0);
  });

  // Candidate material is read from the session, never from the wire — the same
  // reason POST /plan stopped accepting it.
  it("reads the resume and repos from the session, not the request", async () => {
    sessionFound();
    const { url } = await start();

    await postGap(url, {
      ...BODY,
      resumeText: "someone else's resume",
      repos: [
        { description: null, name: "evil", fullName: "x/evil", starCount: 9 },
      ],
    });

    expect(structuredCallCount()).toBe(1);
    const item = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(JSON.stringify(item)).not.toContain("someone else's resume");
  });

  it("400s a request with no job description", async () => {
    const { url } = await start();

    const response = await postGap(url, { sessionId: SESSION_ID });

    expect(response.status).toBe(400);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.INVALID_GAP_BODY,
    );
    expect(structuredCallCount()).toBe(0);
  });

  // An analysis of nothing is a Bedrock call that can only produce noise.
  it("400s a whitespace-only job description without calling the model", async () => {
    const { url } = await start();

    const response = await postGap(url, { ...BODY, jobDescription: "   " });

    expect(response.status).toBe(400);
    expect(structuredCallCount()).toBe(0);
  });

  it("401s a request carrying no user", async () => {
    const { url } = await start(null);

    expect((await postGap(url, BODY)).status).toBe(401);
  });

  // Same response for "no such session" and "not yours", so the status cannot
  // be used to test whether a session id is real.
  it("404s someone else's session", async () => {
    sessionFound({ ...META, userId: "someone-else" });
    const { url } = await start();

    const response = await postGap(url, BODY);

    expect(response.status).toBe(404);
    expect(structuredCallCount()).toBe(0);
  });

  it("409s a session whose interview has already started", async () => {
    sessionFound({ ...META, status: "in_progress" });
    const { url } = await start();

    expect((await postGap(url, BODY)).status).toBe(409);
  });

  // 502, not 500: the request was valid and the server is healthy — the
  // upstream model failed or returned something unusable twice.
  // The realistic failure shape: converseStructured wraps an exhausted chain in
  // a BedrockError, and runGapAgent throws one when the output fails validation
  // twice. Both are upstream problems on a valid request, hence 502 not 500.
  it("502s a model failure without leaking its detail", async () => {
    sessionFound();
    setStructuredFailure(
      new BedrockError("prompt fragment and AWS internals", ["ministral"]),
    );
    const { url } = await start();

    const response = await postGap(url, BODY);
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain("prompt fragment");
    expect(raw).not.toContain("ministral");
    expect(ErrorBody.parse(JSON.parse(raw)).message).toBe(
      MESSAGES.GAP_UNAVAILABLE,
    );
  });

  // Anything not recognised is ours, not the model's, so it reads as a 500.
  it("500s an unclassified failure rather than blaming the model", async () => {
    sessionFound();
    setStructuredFailure(
      new Error("something unexpected with internals in it"),
    );
    const { url } = await start();

    const response = await postGap(url, BODY);
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain("something unexpected");
  });

  it("does not persist anything when the analysis fails", async () => {
    sessionFound();
    setStructuredFailure(new BedrockError("model unavailable", ["ministral"]));
    const { url } = await start();

    await postGap(url, BODY);

    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

// Flattened in the route so the agent's input stays four plain strings — it
// never learns what a repo is.
describe("summariseRepos", () => {
  it("renders one line per repository", () => {
    expect(
      summariseRepos([
        {
          description: "Kafka consumers",
          name: "order-service",
          fullName: "u/order-service",
          starCount: 42,
        },
        {
          description: null,
          name: "scratch",
          fullName: "u/scratch",
          starCount: 0,
        },
      ]),
    ).toBe("- order-service: Kafka consumers\n- scratch");
  });

  it("is empty for a candidate with no repositories", () => {
    expect(summariseRepos([])).toBe("");
  });
});
