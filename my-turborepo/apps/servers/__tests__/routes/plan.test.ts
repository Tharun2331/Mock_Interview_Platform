import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  ITEM_TYPE,
  SORT_KEY,
  sessionPk,
  userPk,
  type PlanResponse,
} from "@repo/shared";
import { z } from "zod";
import type { MountedApp } from "../helpers/testApp";

const PLAN: PlanResponse = {
  focusAreas: [
    { area: "Kafka", evidence: "order-service", source: "github" },
    { area: "Postgres", evidence: "order-service", source: "github" },
  ],
  questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
  startingDifficulty: "mid",
  targetMinutes: 30,
  reasoning: "why",
};

// Bedrock is the one dependency stubbed, and it is stubbed at the `lib/bedrock`
// leaf rather than by replacing `agents/planner`.
//
// That distinction is not stylistic. `mock.module` is global and permanent for
// the process, so mocking `agents/planner` here hijacked agents/planner.test.ts
// on Linux CI — it loaded afterwards and got this file's stub. Mocking the leaf
// means the REAL planner runs here, which makes these route tests stronger too:
// the plan in the response is genuinely parsed out of a model reply.
import {
  converseCallCount,
  lastConverseCall,
  resetBedrockStub,
  resetStructuredStub,
  setModelFailure,
  setModelReply,
  setStructuredFailure,
  setStructuredReplies,
  structuredCallCount,
} from "../helpers/bedrockStub";

const { planRouter } = await import("../../routes/plan");
const { MESSAGES } = await import("../../lib/messages");
const { BedrockError } = await import("../../lib/errors");
const { mount } = await import("../helpers/testApp");

const ddb = mockClient(DynamoDBDocumentClient);

const TABLE = "prepilot-sessions-test";
const SESSION_ID = "01J000000000000000000000";
const USER = { id: "user-1", username: "tharun" };
const NOW = "2026-09-09T12:00:00.000Z";

const META = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.META,
  type: ITEM_TYPE.SESSION_META,
  sessionId: SESSION_ID,
  userId: USER.id,
  status: "planning",
  createdAt: NOW,
  profileVersion: 3,
};

const INPUTS = {
  PK: sessionPk(SESSION_ID),
  SK: SORT_KEY.INPUTS,
  type: ITEM_TYPE.SESSION_INPUTS,
  repos: [{ description: null, name: "a", fullName: "u/a", starCount: 1 }],
  resumeText: "redacted text",
  resumeKey: "resumes/user-1/resume.pdf",
};

function cachedPlanItem(overrides: Record<string, unknown> = {}) {
  return {
    PK: userPk(USER.id),
    SK: SORT_KEY.PLAN,
    type: ITEM_TYPE.CACHED_PLAN,
    plan: PLAN,
    targetRole: "Backend Engineer",
    profileVersion: 3,
    generatedAt: NOW,
    ...overrides,
  };
}

const ErrorBody = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

let app: MountedApp | undefined;

async function start(user: { id: string; username: string } | null = USER) {
  app = await mount({ path: "/api/v1/plan", router: planRouter, user });
  return app;
}

async function postPlan(url: string, body: unknown) {
  return fetch(`${url}/api/v1/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// The happy-path session read. Individual tests override the cache response.
function sessionFound(meta: Record<string, unknown> = META) {
  ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [meta, INPUTS] } });
}

const BODY = { sessionId: SESSION_ID, targetRole: "Backend Engineer" };

beforeEach(() => {
  ddb.reset();
  resetBedrockStub();
  // The structured half too. Both live on the same stubbed module, and its call
  // counts are cumulative for the whole process — without this, the gap-trigger
  // assertions here count every call agents/gap.test.ts made before them.
  resetStructuredStub();
  // A well-formed generation by default; failure cases override it.
  setModelReply(JSON.stringify(PLAN));
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

afterAll(() => {
  ddb.restore();
});

describe("validation", () => {
  it("400s a body with no session id", async () => {
    const { url } = await start();

    const response = await postPlan(url, { targetRole: "Backend Engineer" });

    expect(response.status).toBe(400);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.INVALID_PLAN_BODY,
    );
  });

  it("401s when the request carries no user", async () => {
    const { url } = await start(null);

    expect((await postPlan(url, BODY)).status).toBe(401);
  });

  // Candidate material is read from the session, never the request — accepting
  // it on the wire let a caller plan against someone else's resume.
  it("ignores repos and resume text sent by the client", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    await postPlan(url, {
      ...BODY,
      resumeText: "someone else's resume",
      repos: [
        { description: null, name: "evil", fullName: "x/evil", starCount: 9 },
      ],
    });

    // Asserted on the prompt the real Planner built, which is the last point
    // the client's material could still have crept in.
    const prompt = lastConverseCall()?.prompt ?? "";
    expect(prompt).toContain("redacted text");
    expect(prompt).toContain("- a (1★)");
    expect(prompt).not.toContain("someone else's resume");
    expect(prompt).not.toContain("evil");
  });
});

describe("the plan cache", () => {
  it("serves a fresh cached plan without calling the model", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({ Item: cachedPlanItem() });
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(200);
    expect(converseCallCount()).toBe(0);
    // Still persisted to the session — a cache hit is not a no-op.
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  it("regenerates when the profile version has moved on", async () => {
    sessionFound();
    ddb
      .on(GetCommand)
      .resolves({ Item: cachedPlanItem({ profileVersion: 2 }) });
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    await postPlan(url, BODY);

    expect(converseCallCount()).toBe(1);
  });

  it("regenerates for a genuinely different role", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({ Item: cachedPlanItem() });
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    await postPlan(url, { ...BODY, targetRole: "Frontend Engineer" });

    expect(converseCallCount()).toBe(1);
  });

  // Roles are free text, so these are the same interview and must hit the same
  // cache entry.
  it("treats a differently-cased role as the same role", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({ Item: cachedPlanItem() });
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    await postPlan(url, { ...BODY, targetRole: "  backend   ENGINEER " });

    expect(converseCallCount()).toBe(0);
  });

  // The comparison is against the SESSION's profileVersion, not the profile's
  // current one. Checking the live profile would serve a plan built from new
  // material to a session still holding the old snapshot.
  it("compares against the session's version, not the profile's current one", async () => {
    // Session snapshotted at 3; the cached plan was built at 3. Fresh, even
    // though the candidate has since saved their profile again.
    sessionFound({ ...META, profileVersion: 3 });
    ddb
      .on(GetCommand)
      .resolves({ Item: cachedPlanItem({ profileVersion: 3 }) });
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    await postPlan(url, BODY);

    expect(converseCallCount()).toBe(0);
  });

  // A miss and an outage cost the same thing — one generation — so a broken
  // cache degrades to a miss rather than failing a request the Planner can
  // still serve.
  it("plans fresh when the cache read fails, rather than failing the request", async () => {
    sessionFound();
    ddb.on(GetCommand).rejects(new Error("throughput exceeded"));
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(200);
    expect(converseCallCount()).toBe(1);
  });

  // Failure here loses a cache entry, not the plan. The candidate has their
  // interview either way.
  it("still succeeds when the cache write fails", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).rejects(new Error("throughput exceeded"));
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PLAN);
  });

  // Stamped with the version read at the top of the handler, not re-read after
  // the model call: a profile saved while Bedrock was running would otherwise
  // mark this plan as matching material it never saw.
  it("stamps the cache with the version it actually planned against", async () => {
    sessionFound({ ...META, profileVersion: 3 });
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    await postPlan(url, BODY);

    const item = ddb.commandCalls(PutCommand)[0]?.args[0].input.Item;
    expect(item?.profileVersion).toBe(3);
    expect(item?.SK).toBe(SORT_KEY.PLAN);
  });

  // Sessions created before profiles existed have no version, and an absent one
  // simply never matches a cached plan.
  it("skips the cache entirely for a session with no profile version", async () => {
    sessionFound({ ...META, profileVersion: undefined });
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(200);
    expect(converseCallCount()).toBe(1);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});

// The Planner triggers the Gap agent and deliberately never reads its output.
// A job description is optional throughout, and its absence means the agent is
// skipped entirely rather than called with an empty string.
describe("the gap trigger", () => {
  // A second structured call is the only observable difference, since the
  // trigger is fire-and-forget and the plan response is identical either way.
  function gapCalls(): number {
    return structuredCallCount();
  }

  it("does not run the Gap agent when no job description was sent", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(200);
    expect(gapCalls()).toBe(0);
  });

  it("still returns a valid plan without one", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(await response.json()).toEqual(PLAN);
    expect(gapCalls()).toBe(0);
  });

  it("runs the Gap agent when a job description is present", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    setStructuredReplies([
      {
        requirements: [
          {
            requirement: "Kubernetes",
            bucket: "none",
            evidence: "not mentioned",
          },
        ],
      },
    ]);
    const { url } = await start();

    const response = await postPlan(url, {
      ...BODY,
      jobDescription: "We need Kubernetes and Terraform experience.",
    });

    expect(response.status).toBe(200);
    // Fire-and-forget, so the write lands after the response. Awaited here only
    // to let the microtask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gapCalls()).toBe(1);
  });

  // The plan is what the candidate is waiting for. A failed analysis costs the
  // interview its targeting, not its plan.
  it("returns the plan even when the analysis fails", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    setStructuredFailure(new Error("model unavailable"));
    const { url } = await start();

    const response = await postPlan(url, {
      ...BODY,
      jobDescription: "We need Kubernetes and Terraform experience.",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PLAN);
    // Drained before the test ends. runGapAgent retries once on failure, so the
    // trigger outlives the response by two model calls — and a call landing
    // after the next test's reset would be counted against that test instead.
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  // Whitespace is not a job description. Trimmed to nothing by the schema, so
  // it is rejected before the handler body runs at all.
  //
  // Asserted on the status alone: a 400 means nothing downstream executed,
  // which is a stronger statement than a call count — and one that cannot be
  // perturbed by a previous test's in-flight trigger.
  it("rejects a whitespace-only job description rather than analysing it", async () => {
    const { url } = await start();

    const response = await postPlan(url, { ...BODY, jobDescription: "   " });

    expect(response.status).toBe(400);
  });
});

// Gated behind the job description as well as the company name, which is the
// spec's rule and not an accident: no posting means no Gap agent AND no
// Company Intel, so a session cannot end up shaped by a company's reputation
// with nothing to aim it at.
//
// Whether researchCompany ran is observed through the DynamoDB write it makes
// (SK === SORT_KEY.INTEL), not through a Bedrock call count: the Gap agent in
// the same request also calls converseStructured, so a shared counter cannot
// tell the two apart.
describe("the company intel trigger", () => {
  function readyToPlan() {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
  }

  function intelWasStored(): boolean {
    return ddb
      .commandCalls(PutCommand)
      .some((call) => call.args[0].input.Item?.SK === SORT_KEY.INTEL);
  }

  it("researches the company when both a posting and a name are present", async () => {
    readyToPlan();
    const { url } = await start();

    const response = await postPlan(url, {
      ...BODY,
      jobDescription: "We need Kubernetes experience.",
      companyName: "Acme Systems",
      companyNotes: "Pairing on a real bug, no whiteboard.",
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(intelWasStored()).toBe(true);
  });

  // The amendment's rule, and the one most worth pinning: a company name with
  // no posting must not run Company Intel at all.
  it("does not research when a company name arrives without a posting", async () => {
    readyToPlan();
    const { url } = await start();

    const response = await postPlan(url, {
      ...BODY,
      companyName: "Acme Systems",
    });

    expect(response.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(intelWasStored()).toBe(false);
  });

  it("does not research when a posting arrives without a company name", async () => {
    readyToPlan();
    setStructuredReplies([{ requirements: [] }]);
    const { url } = await start();

    await postPlan(url, {
      ...BODY,
      jobDescription: "We need Kubernetes experience.",
    });

    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(intelWasStored()).toBe(false);
  });

  // Same treatment as the gap trigger: the plan is what the candidate is
  // waiting for, and this is the most optional thing in the product. The only
  // failure mode left, with no external search, is the classification call.
  it("returns the plan even when the classification fails outright", async () => {
    readyToPlan();
    setStructuredFailure(new Error("chain exhausted"));
    const { url } = await start();

    const response = await postPlan(url, {
      ...BODY,
      jobDescription: "We need Kubernetes experience.",
      companyName: "Acme Systems",
      companyNotes: "Pairing on a real bug, no whiteboard.",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PLAN);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

  it("does not delay the response on it", async () => {
    readyToPlan();
    const { url } = await start();

    const started = Date.now();
    await postPlan(url, {
      ...BODY,
      jobDescription: "We need Kubernetes experience.",
      companyName: "Acme Systems",
      companyNotes: "Pairing on a real bug, no whiteboard.",
    });

    // Fire-and-forget: the response must not wait on the classification call,
    // the slowest thing in this route.
    expect(Date.now() - started).toBeLessThan(1_000);
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
});

describe("persistence", () => {
  it("attaches the plan to the session after the model call", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    const { url } = await start();

    await postPlan(url, BODY);

    const values =
      ddb.commandCalls(UpdateCommand)[0]?.args[0].input
        .ExpressionAttributeValues;
    expect(values?.[":plan"]).toEqual(PLAN);
    // Derived from the mix, not trusted from the client.
    expect(values?.[":questionCount"]).toBe(10);
    expect(values?.[":status"]).toBe("ready");
  });

  // A Bedrock failure leaves the session at `planning` so the candidate can
  // retry against the same session rather than re-uploading.
  it("does not touch the session when the model fails", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    setModelFailure(
      new BedrockError("all models failed", ["ministral", "llama"]),
    );
    const { url } = await start();

    await postPlan(url, BODY);

    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("failure mapping", () => {
  it("404s an unknown session without confirming whether it exists", async () => {
    ddb.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [] } });
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(404);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.SESSION_NOT_FOUND,
    );
  });

  it("404s someone else's session with the identical response", async () => {
    ddb.on(BatchGetCommand).resolves({
      Responses: { [TABLE]: [{ ...META, userId: "someone-else" }, INPUTS] },
    });
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(404);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.SESSION_NOT_FOUND,
    );
  });

  // 409, not 404: the session exists and is theirs, it is just past the point
  // where a plan can change.
  it("409s a session whose interview has already started", async () => {
    sessionFound({ ...META, status: "in_progress" });
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(409);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.SESSION_ALREADY_STARTED,
    );
  });

  // The race the condition expression closes: the interview started while the
  // model was thinking.
  it("409s when the interview starts mid-generation", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    const failure = new ConditionalCheckFailedException({
      $metadata: {},
      message: "failed",
    });
    Object.assign(failure, { Item: { userId: { S: USER.id } } });
    ddb.on(UpdateCommand).rejects(failure);
    const { url } = await start();

    expect((await postPlan(url, BODY)).status).toBe(409);
  });

  // The plan succeeded and storing it did not, so this must not read as a model
  // failure — 500 for our problem, not 502 for an upstream one.
  it("500s when persisting the plan fails", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).rejects(new Error("throughput exceeded"));
    const { url } = await start();

    const response = await postPlan(url, BODY);

    expect(response.status).toBe(500);
    expect(ErrorBody.parse(await response.json()).message).toBe(
      MESSAGES.SESSION_UNAVAILABLE,
    );
  });

  // 502, not 500: the request was valid and the server is healthy — the
  // upstream model failed or returned something unusable.
  it("502s a Bedrock failure and keeps its detail out of the response", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    setModelFailure(
      new BedrockError("prompt fragment and AWS internals", ["ministral"]),
    );
    const { url } = await start();

    const response = await postPlan(url, BODY);
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(ErrorBody.parse(JSON.parse(raw)).message).toBe(MESSAGES.PLAN_FAILED);
    expect(raw).not.toContain("prompt fragment");
    expect(raw).not.toContain("ministral");
  });

  it("502s an unrecognised failure rather than leaking it", async () => {
    sessionFound();
    ddb.on(GetCommand).resolves({});
    setModelFailure(new Error("something unexpected with internals in it"));
    const { url } = await start();

    const response = await postPlan(url, BODY);
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(raw).not.toContain("something unexpected");
  });
});
