import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  ComprehendClient,
  DetectPiiEntitiesCommand,
  PiiEntityType,
} from "@aws-sdk/client-comprehend";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import {
  ITEM_TYPE,
  ProfileResponseSchema,
  ResumeUploadResponseSchema,
  SORT_KEY,
  userPk,
} from "@repo/shared";
import { z } from "zod";
import { minimalPdf, corruptPdf } from "../helpers/pdf";
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
// The other two services the resume upload fans out to. Mocked at the client
// rather than at lib/s3 or lib/redact, both of which have tests of their own
// that a module stub would hijack — the rule bedrockStub.ts encodes.
const s3 = mockClient(S3Client);
const comprehend = mockClient(ComprehendClient);

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
  s3.reset();
  comprehend.reset();
  fetchRepos.mockClear();
  s3.on(PutObjectCommand).resolves({});
  // Nothing personal found by default, so a test about the upload path is not
  // also asserting about redaction — redact.test.ts owns that.
  comprehend.on(DetectPiiEntitiesCommand).resolves({ Entities: [] });
});

afterEach(async () => {
  if (app !== undefined) {
    await app.close();
    app = undefined;
  }
});

afterAll(() => {
  ddb.restore();
  s3.restore();
  comprehend.restore();
});

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

// The successful path, which nothing exercised before: a real PDF through
// multipart, parsed by pdf.js, scanned by Comprehend, archived in S3, and
// written to DynamoDB in that order.
describe("uploading a resume that works", () => {
  const UPLOADED = {
    ...STORED_PROFILE,
    resumeText: "Tharun Sekar backend engineer Kafka Postgres",
    profileVersion: 4,
  };

  function upload(args: { pdf?: Uint8Array; gitHub?: string } = {}) {
    const form = new FormData();
    const bytes = args.pdf ?? minimalPdf("Tharun Sekar backend engineer Kafka Postgres");
    form.set(
      "resume",
      new File([bytes], "resume.pdf", { type: "application/pdf" })
    );
    if (args.gitHub !== undefined) form.set("gitHub", args.gitHub);
    return form;
  }

  async function post(url: string, form: FormData) {
    return fetch(`${url}/api/v1/profile/resume`, { method: "POST", body: form });
  }

  beforeEach(() => {
    ddb.on(UpdateCommand).resolves({ Attributes: UPLOADED });
  });

  it("stores the resume and returns the updated profile", async () => {
    const { url } = await start();

    const response = await post(url, upload());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ profile: { hasResume: true } });
  });

  it("reports what the parse found", async () => {
    const { url } = await start();

    const response = await post(url, upload());
    // Parsed against the shared contract rather than cast. `response.json()` is
    // `unknown`, and validating it here means the test also proves the route
    // answers the shape the browser is typed against.
    const body = ResumeUploadResponseSchema.parse(await response.json());

    expect(body.resume.pages).toBe(1);
    expect(body.resume.characters).toBeGreaterThan(0);
  });

  // The archive is written BEFORE the item, so a failure between them leaves an
  // orphaned object rather than a profile pointing at one that was never stored.
  it("archives the raw PDF at the candidate's stable key", async () => {
    const { url } = await start();

    await post(url, upload());

    const put = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(put?.Key).toBe(`resumes/${USER.id}/resume.pdf`);
    expect(put?.ContentType).toBe("application/pdf");
  });

  // The bytes uploaded to S3 are the same ones pdf.js was handed. pdf.js
  // transfers its input buffer, so without the copy in lib/resume.ts this
  // stores a zero-byte object and reports success.
  it("archives the whole file, not a buffer pdf.js already emptied", async () => {
    const { url } = await start();

    await post(url, upload());

    const body = s3.commandCalls(PutObjectCommand)[0]?.args[0].input.Body;
    expect((body as Uint8Array).byteLength).toBeGreaterThan(100);
  });

  // Repos are Planner input, so a new resume must evict the cached plan.
  it("bumps profileVersion atomically", async () => {
    const { url } = await start();

    await post(url, upload());

    const update = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(String(update?.UpdateExpression)).toContain("ADD profileVersion");
  });

  // What reaches DynamoDB is the REDACTED text — this is the inference
  // boundary, and the raw text must never be stored.
  it("stores text that went through the redactor", async () => {
    comprehend.on(DetectPiiEntitiesCommand).resolves({
      Entities: [
        { Type: PiiEntityType.NAME, Score: 0.99, BeginOffset: 0, EndOffset: 13 },
      ],
    });
    const { url } = await start();

    const response = await post(url, upload());
    const body = ResumeUploadResponseSchema.parse(await response.json());

    expect(body.resume.redactedCount).toBe(1);
    // Counts and type names only. A summary quoting the removed values would
    // undo the removal.
    expect(JSON.stringify(body.resume)).not.toContain("Tharun");

    const update = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    const stored = String(update?.ExpressionAttributeValues?.[":resumeText"]);
    expect(stored).not.toContain("Tharun Sekar");
  });

  it("scrapes GitHub when a profile URL comes with the upload", async () => {
    const { url } = await start();

    await post(url, upload({ gitHub: "https://github.com/Tharun2331" }));

    expect(fetchRepos).toHaveBeenCalledWith("Tharun2331");
  });

  it("does not scrape when no GitHub URL was given", async () => {
    const { url } = await start();

    await post(url, upload());

    expect(fetchRepos).not.toHaveBeenCalled();
  });

  it("400s an invalid GitHub URL without storing anything", async () => {
    const { url } = await start();

    const response = await post(url, upload({ gitHub: "https://evil.com/x" }));

    expect(response.status).toBe(400);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("an upload that fails part-way", () => {
  function pdfForm(bytes: Uint8Array) {
    const form = new FormData();
    form.set("resume", new File([bytes], "resume.pdf", { type: "application/pdf" }));
    return form;
  }

  it("422s a PDF that cannot be read", async () => {
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      body: pdfForm(corruptPdf()),
    });

    expect(response.status).toBe(422);
    expect((await errorBody(response)).message).toBe(MESSAGES.RESUME_PARSE_FAILED);
  });

  it("stores nothing when the PDF cannot be read", async () => {
    const { url } = await start();

    await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      body: pdfForm(corruptPdf()),
    });

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  // Redaction fails CLOSED. Storing text only the deterministic pass had seen
  // would put names and addresses in DynamoDB with nothing downstream able to
  // tell — so the upload is rejected instead.
  it("503s rather than storing unscanned text", async () => {
    comprehend.on(DetectPiiEntitiesCommand).rejects(new Error("ThrottlingException"));
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      body: pdfForm(minimalPdf("Tharun Sekar")),
    });

    expect(response.status).toBe(503);
    expect((await errorBody(response)).message).toBe(
      MESSAGES.REDACTION_UNAVAILABLE
    );
  });

  it("stores nothing at all when redaction fails", async () => {
    comprehend.on(DetectPiiEntitiesCommand).rejects(new Error("ThrottlingException"));
    const { url } = await start();

    await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      body: pdfForm(minimalPdf("Tharun Sekar")),
    });

    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  // The object is written first, so a DynamoDB failure leaves an orphan in S3
  // rather than a profile pointing at nothing. The candidate sees a failure
  // either way and can retry, which overwrites the orphan.
  it("reports a failure when the profile write fails after the archive", async () => {
    ddb.on(UpdateCommand).rejects(new Error("ProvisionedThroughputExceeded"));
    const { url } = await start();

    const response = await fetch(`${url}/api/v1/profile/resume`, {
      method: "POST",
      body: pdfForm(minimalPdf("Tharun Sekar")),
    });

    expect(response.status).toBe(500);
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(1);
    const raw = await response.text();
    expect(raw).not.toContain("ProvisionedThroughput");
  });
});
