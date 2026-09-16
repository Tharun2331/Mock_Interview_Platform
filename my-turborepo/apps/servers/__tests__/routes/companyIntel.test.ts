import {
  afterAll,
  afterEach,
  beforeAll,
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
import { CompanyIntelSchema, ITEM_TYPE, SORT_KEY, sessionPk } from "@repo/shared";
import { z } from "zod";
import {
  resetStructuredStub,
  setStructuredFailure,
  setStructuredReplies,
} from "../helpers/bedrockStub";
import { resetSsmStub } from "../helpers/ssmStub";
import {
  installSearchStub,
  resetSearchStub,
  restoreSearchStub,
  setSearchEmpty,
  setSearchResults,
  setSearchThrows,
} from "../helpers/searchStub";
import type { MountedApp } from "../helpers/testApp";

const { companyIntelRouter } = await import("../../routes/companyIntel");
const { MESSAGES } = await import("../../lib/messages");
const { mount } = await import("../helpers/testApp");

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = "prepilot-sessions-test";
const SESSION_ID = "01J000000000000000000000";
const USER = { id: "user-1", username: "tharun" };

const META = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.META,
  type: ITEM_TYPE.SESSION_META,
  sessionId: SESSION_ID,
  userId: USER.id,
  status: "ready",
  createdAt: "2026-09-16T10:00:00.000Z",
  profileVersion: 3,
};

const INPUTS = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.INPUTS,
  type: ITEM_TYPE.SESSION_INPUTS,
  repos: [],
  resumeText: "Three years of React and Node at EY.",
  resumeKey: "resumes/user-1/resume.pdf",
};

const SNIPPETS = [
  { title: "Acme interview guide", content: "Pairing on a real bug, no whiteboard." },
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
  app = await mount({ path: "/api/v1/company", router: companyIntelRouter, user });
  return app;
}

async function postIntel(url: string, body: unknown) {
  return fetch(`${url}/api/v1/company`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const BODY = { sessionId: SESSION_ID, companyName: "Acme Systems" };

beforeAll(installSearchStub);
afterAll(() => {
  restoreSearchStub();
  ddb.restore();
});

beforeEach(() => {
  ddb.reset();
  resetStructuredStub();
  resetSsmStub();
  resetSearchStub();
  setSearchResults(SNIPPETS, SNIPPETS);
  setStructuredReplies([
    { style: "practical", focus: "infrastructure", seniority: "senior" },
  ]);
  ddb.on(PutCommand).resolves({});
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

describe("POST /api/v1/company", () => {
  it("researches the company and returns the reading", async () => {
    sessionFound();
    const { url } = await start();

    const response = await postIntel(url, BODY);
    const intel = CompanyIntelSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(intel.company).toBe("Acme Systems");
    expect(intel.style).toBe("practical");
  });

  it("persists it against the session", async () => {
    sessionFound();
    const { url } = await start();

    await postIntel(url, BODY);

    const item = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item?.PK).toBe(sessionPk(SESSION_ID));
    expect(item?.SK).toBe(SORT_KEY.INTEL);
    // Every session-scoped item carries one, or it outlives the session.
    expect(item?.expiresAt).toBeGreaterThan(0);
  });

  it("400s a request with no company name", async () => {
    const { url } = await start();

    const response = await postIntel(url, { sessionId: SESSION_ID });

    expect(response.status).toBe(400);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.INVALID_INTEL_BODY
    );
  });

  it("400s a whitespace-only company name", async () => {
    const { url } = await start();

    expect((await postIntel(url, { ...BODY, companyName: "   " })).status).toBe(400);
  });

  it("401s a request carrying no user", async () => {
    const { url } = await start(null);

    expect((await postIntel(url, BODY)).status).toBe(401);
  });

  // Same response for "no such session" and "not yours", so the status cannot
  // be used to test whether a session id is real.
  it("404s someone else's session", async () => {
    sessionFound({ ...META, userId: "someone-else" });
    const { url } = await start();

    expect((await postIntel(url, BODY)).status).toBe(404);
  });

  it("does not research a session it does not own", async () => {
    sessionFound({ ...META, userId: "someone-else" });
    const { url } = await start();

    await postIntel(url, BODY);

    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

// The spec's requirement, at the route level: none of these may fail a request.
describe("a reading that found nothing", () => {
  it("still returns 200 when search found nothing", async () => {
    sessionFound();
    setSearchEmpty();
    const { url } = await start();

    const response = await postIntel(url, BODY);

    expect(response.status).toBe(200);
    expect(CompanyIntelSchema.parse(await response.json()).style).toBe("unknown");
  });

  // 200, not 502. An all-unknown result is a successful run of an agent whose
  // honest answer is often "the internet does not say", and a failure status
  // would invite a client to retry a search that returns the same nothing.
  it("still returns 200 when the search API throws", async () => {
    sessionFound();
    setSearchThrows(new Error("ECONNREFUSED"));
    const { url } = await start();

    expect((await postIntel(url, BODY)).status).toBe(200);
  });

  it("still returns 200 when the model fails", async () => {
    sessionFound();
    setStructuredFailure(new Error("chain exhausted"));
    const { url } = await start();

    expect((await postIntel(url, BODY)).status).toBe(200);
  });

  it("stores the all-unknown reading rather than nothing", async () => {
    sessionFound();
    setSearchEmpty();
    const { url } = await start();

    await postIntel(url, BODY);

    const item = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item?.style).toBe("unknown");
    expect(item?.sourceCount).toBe(0);
  });
});

describe("failures that are ours", () => {
  it("500s a failed write without leaking the cause", async () => {
    sessionFound();
    ddb.on(PutCommand).rejects(new Error("ProvisionedThroughputExceeded on table x"));
    const { url } = await start();

    const response = await postIntel(url, BODY);
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(raw).not.toContain("ProvisionedThroughput");
    expect(raw).not.toContain("table x");
  });
});
