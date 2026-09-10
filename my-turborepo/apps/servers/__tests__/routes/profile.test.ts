import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { ITEM_TYPE, ProfileResponseSchema, SORT_KEY, userPk } from "@repo/shared";
import { z } from "zod";
// Type-only import, erased at runtime, so it cannot defeat the mock ordering.
import type { MountedApp } from "../helpers/testApp";

// The GitHub scrape is axios, not an AWS SDK client, so aws-sdk-client-mock
// cannot reach it. Mocked at the module boundary instead — and BEFORE the
// router is imported, because the router captures the binding on import.
const fetchRepos = mock(async (_username: string) => [
  {
    description: "an order pipeline",
    name: "order-service",
    fullName: "u/order-service",
    starCount: 42,
  },
]);
mock.module("../../lib/github", () => ({ fetchRepos }));

const { profileRouter } = await import("../../routes/profile");
const { MESSAGES } = await import("../../lib/messages");
const { GithubError } = await import("../../lib/errors");
const { mount } = await import("../helpers/testApp");

const ddb = mockClient(DynamoDBDocumentClient);

const USER = { id: "user-1", username: "tharun" };
const NOW = "2026-09-09T12:00:00.000Z";

// The stored item, as DynamoDB hands it back.
const STORED_PROFILE = {
  PK: userPk(USER.id),
  SK: SORT_KEY.PROFILE,
  type: ITEM_TYPE.USER_PROFILE,
  userId: USER.id,
  status: "active",
  createdAt: NOW,
  updatedAt: NOW,
  username: "tharun",
  firstName: "Tharun",
  lastName: "Sekar",
  githubUsername: "Tharun2331",
  resumeKey: "resumes/user-1/resume.pdf",
  resumeText: "REDACTED resume text that must never reach a client",
  repos: [],
  profileVersion: 3,
};

// Error responses use `message`, the two auth guards use `error`. Parsing
// rather than casting keeps `strict` happy without an `any` in sight.
const ErrorBody = z.object({
  message: z.string().optional(),
  error: z.string().optional(),
});

async function errorBody(response: Response) {
  return ErrorBody.parse(await response.json());
}

// Parsed through the published contract, so a handler that returns the right
// status with the wrong shape still fails.
async function profileBody(response: Response) {
  return ProfileResponseSchema.parse(await response.json());
}

function updateExpression(index = 0): string {
  const expression = ddb.commandCalls(UpdateCommand)[index]?.args[0].input
    .UpdateExpression;
  return expression ?? "";
}

let app: MountedApp | undefined;

async function start(user: { id: string; username: string } | null = USER) {
  app = await mount({ path: "/api/v1/profile", router: profileRouter, user });
  return app;
}

beforeEach(() => {
  ddb.reset();
  fetchRepos.mockClear();
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

afterAll(() => ddb.restore());

describe("GET /api/v1/profile", () => {
  it("returns the profile view for a saved profile", async () => {
    ddb.on(GetCommand).resolves({ Item: STORED_PROFILE });
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile`);
    const body = await profileBody(response);

    expect(response.status).toBe(200);
    expect(body.profile?.userId).toBe(USER.id);
    expect(body.profile?.complete).toBe(true);
    expect(body.profile?.hasResume).toBe(true);
    expect(body.profile?.repoCount).toBe(0);
  });

  // The single most important assertion on this route. resumeText is the
  // candidate's resume and resumeKey is server-side S3 addressing; neither has
  // any business reaching a browser.
  it("never leaks resume text or the S3 key", async () => {
    ddb.on(GetCommand).resolves({ Item: STORED_PROFILE });
    const { url } = await start();

    const raw = await (await fetch(`${url}/api/v1/profile`)).text();

    expect(raw).not.toContain("resumeText");
    expect(raw).not.toContain("REDACTED resume text");
    expect(raw).not.toContain("resumeKey");
    expect(raw).not.toContain("resumes/user-1/resume.pdf");
  });

  // Null, not 404 — the expected state on first sign-in, and exactly what the
  // onboarding guard is asking this route.
  it("returns a null profile rather than 404 for a first-time candidate", async () => {
    ddb.on(GetCommand).resolves({});
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile`);

    expect(response.status).toBe(200);
    expect((await profileBody(response)).profile).toBeNull();
  });

  it("reads strongly consistent, so onboarding cannot bounce a candidate back", async () => {
    ddb.on(GetCommand).resolves({ Item: STORED_PROFILE });
    const { url } = await start();

    await fetch(`${url}/api/v1/profile`);

    const input = ddb.commandCalls(GetCommand)[0]?.args[0].input;
    expect(input?.ConsistentRead).toBe(true);
    expect(input?.Key).toEqual({ PK: userPk(USER.id), SK: SORT_KEY.PROFILE });
  });

  it("401s when the request carries no user", async () => {
    const { url } = await start(null);

    const response = await fetch(`${url}/api/v1/profile`);

    expect(response.status).toBe(401);
    expect((await errorBody(response)).error).toBe(
      MESSAGES.UNAUTHORIZED_INVALID_TOKEN
    );
  });

  // ServiceError messages can carry AWS internals, so the route must answer
  // with its own generic copy and keep the detail in the log.
  it("maps a DynamoDB failure to a generic 500 without quoting it", async () => {
    ddb.on(GetCommand).rejects(
      new Error("ResourceNotFoundException: table prepilot-x")
    );
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile`);
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(ErrorBody.parse(JSON.parse(raw)).message).toBe(
      MESSAGES.PROFILE_UNAVAILABLE
    );
    expect(raw).not.toContain("ResourceNotFoundException");
    expect(raw).not.toContain("prepilot-x");
  });

  // Validate-on-read: an item written by an older deploy must fail loudly at
  // the storage boundary rather than surface `undefined` three layers up.
  it("500s on a stored item that no longer matches the schema", async () => {
    ddb.on(GetCommand).resolves({
      Item: { ...STORED_PROFILE, profileVersion: "three" },
    });
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile`);

    expect(response.status).toBe(500);
    expect((await errorBody(response)).message).toBe(MESSAGES.PROFILE_UNAVAILABLE);
  });
});

describe("PUT /api/v1/profile", () => {
  const DETAILS = { username: "tharun", firstName: "Tharun", lastName: "Sekar" };

  async function put(url: string, body: unknown) {
    return fetch(`${url}/api/v1/profile`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("saves display fields and returns the updated view", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: STORED_PROFILE });
    const { url } = await start();

    const response = await put(url, DETAILS);

    expect(response.status).toBe(200);
    expect((await profileBody(response)).profile?.firstName).toBe("Tharun");
  });

  // A display name has no bearing on the interview plan, so bumping the version
  // here would evict the cached plan and buy a Bedrock call for nothing.
  it("does not bump profileVersion — that would evict the plan cache for free", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: STORED_PROFILE });
    const { url } = await start();

    await put(url, DETAILS);

    expect(updateExpression()).not.toContain("ADD profileVersion");
  });

  it("400s on a body missing a required field", async () => {
    const { url } = await start();

    const response = await put(url, { username: "tharun" });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).message).toBe(MESSAGES.INVALID_BODY);
  });

  it("400s on a whitespace-only name", async () => {
    const { url } = await start();

    expect((await put(url, { ...DETAILS, firstName: "   " })).status).toBe(400);
  });

  // 409, and the message passes through: ownership is already proven, so
  // saying what is wrong leaks nothing and the candidate needs to know.
  it("409s when the account is mid-erasure", async () => {
    ddb.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({ $metadata: {}, message: "failed" })
    );
    const { url } = await start();

    const response = await put(url, DETAILS);

    expect(response.status).toBe(409);
    expect((await errorBody(response)).message).toBe(MESSAGES.PROFILE_DELETING);
  });
});

describe("PUT /api/v1/profile/github", () => {
  async function putGithub(url: string, body: unknown) {
    return fetch(`${url}/api/v1/profile/github`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("scrapes the repositories before writing the profile", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: STORED_PROFILE });
    const { url } = await start();

    const response = await putGithub(url, {
      gitHub: "https://github.com/Tharun2331",
    });

    expect(response.status).toBe(200);
    expect(fetchRepos).toHaveBeenCalledWith("Tharun2331");
  });

  // The write must never land while the scrape is unresolved, or a profile is
  // left pointing at a username whose repositories could not be read.
  it("does not write the profile when the scrape fails", async () => {
    fetchRepos.mockImplementationOnce(async () => {
      throw new GithubError("rate limited by GitHub");
    });
    ddb.on(UpdateCommand).resolves({ Attributes: STORED_PROFILE });
    const { url } = await start();

    const response = await putGithub(url, {
      gitHub: "https://github.com/Tharun2331",
    });
    const raw = await response.text();

    expect(response.status).toBe(502);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
    // The upstream detail stays in the log, not the response.
    expect(raw).not.toContain("rate limited by GitHub");
    expect(ErrorBody.parse(JSON.parse(raw)).message).toBe(
      MESSAGES.GITHUB_FETCH_FAILED
    );
  });

  it("400s on a non-GitHub URL without calling out to it", async () => {
    const { url } = await start();

    const response = await putGithub(url, {
      gitHub: "https://evil.com/Tharun2331",
    });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).message).toBe(MESSAGES.INVALID_GITHUB_URL);
    expect(fetchRepos).not.toHaveBeenCalled();
  });

  // A cleared input box arrives as "", which means disconnect — not an error.
  it("clears the connection when the field is blank, scraping nothing", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: STORED_PROFILE });
    const { url } = await start();

    const response = await putGithub(url, { gitHub: "" });

    expect(response.status).toBe(200);
    expect(fetchRepos).not.toHaveBeenCalled();
    expect(updateExpression()).toContain("REMOVE githubUsername");
  });

  // Repos are Planner input, so a plan built before this is no longer built
  // from the candidate's material.
  it("bumps profileVersion atomically, since repos are Planner input", async () => {
    ddb.on(UpdateCommand).resolves({ Attributes: STORED_PROFILE });
    const { url } = await start();

    await putGithub(url, { gitHub: "https://github.com/Tharun2331" });

    // ADD, not SET with a read value — two racing uploads would otherwise both
    // read 3 and both write 4.
    expect(updateExpression()).toContain("ADD profileVersion :one");
  });
});

describe("DELETE /api/v1/profile", () => {
  // A partial erasure is its own outcome: the marker survives, the account
  // stays locked, and retrying resumes rather than restarts.
  it("reports a failed erasure with its own message, not the generic one", async () => {
    ddb.on(UpdateCommand).rejects(new Error("throughput exceeded"));
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile`, { method: "DELETE" });
    const raw = await response.text();

    expect(response.status).toBe(500);
    expect(ErrorBody.parse(JSON.parse(raw)).message).toBe(
      MESSAGES.ACCOUNT_DELETE_FAILED
    );
    expect(raw).not.toContain("throughput exceeded");
  });

  it("401s when the request carries no user at all", async () => {
    const { url } = await start(null);

    const response = await fetch(`${url}/api/v1/profile`, { method: "DELETE" });

    expect(response.status).toBe(401);
  });
});

describe("POST /api/v1/profile/resume", () => {
  it("415s a request that is not multipart", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resume: "not a file" }),
    });

    expect(response.status).toBe(415);
    expect((await errorBody(response)).message).toBe(MESSAGES.EXPECTED_MULTIPART);
  });

  it("400s multipart that carries no resume part", async () => {
    const form = new FormData();
    form.set("gitHub", "https://github.com/Tharun2331");
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(400);
    expect((await errorBody(response)).message).toBe(MESSAGES.RESUME_REQUIRED);
  });

  // Nothing is written until parsing, scraping and redaction have all
  // succeeded, which is what makes overwriting a stable S3 key safe.
  it("writes nothing to DynamoDB when the upload is rejected", async () => {
    const { url } = await start();

    await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });

    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
