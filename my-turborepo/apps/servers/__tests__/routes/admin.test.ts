import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import {
  AdminAccessResponseSchema,
  AdminUsersResponseSchema,
  ITEM_TYPE,
  SORT_KEY,
  userPk,
  type AdminAccessResponse,
  type AdminUsersResponse,
} from "@repo/shared";
import { RequireAdmin } from "../../lib/adminAuth";
import { config } from "../../lib/config";
import { MESSAGES } from "../../lib/messages";
import { adminRouter } from "../../routes/admin";
import { mount, type MountedApp } from "../helpers/testApp";

// The two user-management routes, mounted behind the REAL RequireAdmin.
//
// Both AWS clients are mocked at the class, so the module-level singletons in
// lib/dynamo.ts and lib/cognitoAdmin.ts are intercepted through the prototype.
// Nothing here uses `mock.module`: lib/cognitoDirectory and lib/profile are part of
// what is under test, and stubbing either would delete the filter construction and
// the projection from the suite while appearing to cover them.

const cognito = mockClient(CognitoIdentityProviderClient);
const dynamo = mockClient(DynamoDBDocumentClient);

const PATH = "/api/v1/admin";

const ADMIN = {
  id: "admin-sub",
  username: "admin@example.com",
  groups: [config.adminGroupName],
};

const TABLE = config.sessionsTable;

// A Cognito directory entry. `sub` lives in Attributes, not in Username — they are
// the same string for a plain sign-up and very much not for a federated one.
// Return type annotated as the SDK's own `UserType` rather than inferred. Without
// it `UserStatus: "CONFIRMED"` widens to `string`, which does not satisfy the
// SDK's `UserStatusType` enum — and the failure is type-only, so `bun test` stays
// green while CI breaks. Exactly the class of failure CLAUDE.md records for the
// `@smithy/types` pin.
const cognitoUser = (args: {
  sub: string;
  email: string;
  username?: string;
}): UserType => ({
  Username: args.username ?? args.email,
  Enabled: true,
  UserStatus: "CONFIRMED",
  UserCreateDate: new Date("2026-09-01T00:00:00.000Z"),
  Attributes: [
    { Name: "sub", Value: args.sub },
    { Name: "email", Value: args.email },
  ],
});

const profileItem = (args: {
  sub: string;
  sessionsConducted?: number;
  sessionsCreated?: number;
  unlimitedAccess?: boolean;
  sessionLimit?: number;
}) => ({
  PK: userPk(args.sub),
  SK: SORT_KEY.PROFILE,
  type: ITEM_TYPE.USER_PROFILE,
  userId: args.sub,
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
  firstName: "Tharun",
  lastName: "Sekar",
  resumeKey: `resumes/${args.sub}/resume.pdf`,
  resumeText: "redacted",
  repos: [],
  profileVersion: 2,
  sessionsConducted: args.sessionsConducted ?? 0,
  sessionsCreated: args.sessionsCreated ?? 0,
  unlimitedAccess: args.unlimitedAccess ?? false,
  ...(args.sessionLimit === undefined
    ? {}
    : { sessionLimit: args.sessionLimit }),
});

async function serve(
  user: Parameters<typeof mount>[0]["user"] = ADMIN,
): Promise<MountedApp> {
  return mount({
    path: PATH,
    router: adminRouter,
    user,
    middleware: [RequireAdmin],
  });
}

// `Response.json()` is typed `unknown`, correctly — it is parsed JSON from the
// wire. Success bodies are therefore read through the SHARED SCHEMA rather than
// cast, which makes these two helpers do double duty: they narrow the type, and
// they assert the route emitted a payload the client would actually accept. A
// route that drifted from its schema fails here rather than in the browser.
function usersBody(raw: unknown): AdminUsersResponse {
  return AdminUsersResponseSchema.parse(raw);
}

function accessBody(raw: unknown): AdminAccessResponse {
  return AdminAccessResponseSchema.parse(raw);
}

// Failure bodies have no shared schema — they are `{ message }` and sometimes
// `{ issues }`, which is route-local. Narrowed with a guard rather than a cast, so
// a response that is not an object at all fails as a bad assertion instead of a
// TypeError three lines later.
function failureBody(raw: unknown): {
  message?: unknown;
  issues?: { path?: unknown; message?: unknown }[];
} {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`expected an object body, got ${typeof raw}`);
  }
  return raw;
}

beforeEach(() => {
  cognito.reset();
  dynamo.reset();
});

afterEach(() => {
  cognito.reset();
  dynamo.reset();
});

describe("POST /api/v1/admin/unlimited-access", () => {
  it("resolves the email through Cognito and writes the grant against the sub", async () => {
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [cognitoUser({ sub: "sub-1", email: "a@b.com" })] });
    dynamo.on(UpdateCommand).resolves({
      Attributes: profileItem({ sub: "sub-1", sessionLimit: 10 }),
    });

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "a@b.com",
        unlimitedAccess: false,
        sessionLimit: 10,
      }),
    });

    expect(response.status).toBe(200);

    // The email reaches Cognito as an exact-match filter, and the write lands on
    // the SUB — the two-step this route exists to perform. Keying the DynamoDB
    // write on the email would address an item that does not exist.
    const filter =
      cognito.commandCalls(ListUsersCommand)[0]?.args[0]?.input.Filter;
    expect(filter).toBe('email = "a@b.com"');
    expect(dynamo.commandCalls(UpdateCommand)[0]?.args[0]?.input.Key).toEqual({
      PK: userPk("sub-1"),
      SK: SORT_KEY.PROFILE,
    });

    await app.close();
  });

  it("returns the RESOLVED allowance, not an acknowledgement", async () => {
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [cognitoUser({ sub: "sub-1", email: "a@b.com" })] });
    dynamo.on(UpdateCommand).resolves({
      // Lowered to 1 while 4 have already been used — the case where the operator
      // most needs to see the effect of what they just wrote.
      Attributes: profileItem({
        sub: "sub-1",
        sessionLimit: 1,
        sessionsConducted: 4,
      }),
    });

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "a@b.com",
        unlimitedAccess: false,
        sessionLimit: 1,
      }),
    });

    const body = accessBody(await response.json());
    expect(body.allowance).toEqual({
      unlimited: false,
      limit: 1,
      used: 4,
      // Clamped, not negative.
      remaining: 0,
      exhausted: true,
    });

    await app.close();
  });

  it("404s an email no account owns, and writes nothing", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@b.com", unlimitedAccess: true }),
    });

    expect(response.status).toBe(404);
    expect(failureBody(await response.json()).message).toBe(
      MESSAGES.ADMIN_USER_NOT_FOUND,
    );
    // The important half: no write was attempted against a sub that was never
    // resolved.
    expect(dynamo.commandCalls(UpdateCommand)).toHaveLength(0);

    await app.close();
  });

  it("409s — not 404s — an account that exists but never onboarded", async () => {
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [cognitoUser({ sub: "sub-2", email: "new@b.com" })] });
    dynamo.on(UpdateCommand).rejects(
      new ConditionalCheckFailedException({
        $metadata: {},
        message: "no item",
      }),
    );

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@b.com", unlimitedAccess: true }),
    });

    // The distinction that stops an operator hunting for a typo in an email that
    // was correct. 404 means "no such email"; this means "right email, nothing to
    // grant against yet".
    expect(response.status).toBe(409);
    expect(failureBody(await response.json()).message).toBe(
      MESSAGES.ADMIN_PROFILE_MISSING,
    );

    await app.close();
  });

  it("400s a malformed body and names which field failed", async () => {
    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", unlimitedAccess: false }),
    });

    expect(response.status).toBe(400);
    const body = failureBody(await response.json());
    // Issues are echoed because the caller is the operator — a rejected
    // `sessionLimit: 5000` should say it exceeded the ceiling rather than "invalid".
    expect(body.issues?.[0]?.path).toBe("email");
    // And nothing reached Cognito, so an unvalidated string never became a filter.
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);

    await app.close();
  });

  it("is refused for a non-admin with a 404, before any AWS call", async () => {
    const app = await serve({
      id: "candidate",
      username: "c@b.com",
      groups: [],
    });

    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", unlimitedAccess: true }),
    });

    expect(response.status).toBe(404);
    // The guard runs before the handler, so a non-admin cannot even cause a
    // Cognito lookup — which would otherwise be an unauthenticated way to probe
    // whether an email has an account.
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
    expect(dynamo.commandCalls(UpdateCommand)).toHaveLength(0);

    await app.close();
  });

  it("500s with generic copy when Cognito fails, leaking no AWS detail", async () => {
    cognito.on(ListUsersCommand).rejects(new Error("TooManyRequestsException"));

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", unlimitedAccess: true }),
    });

    expect(response.status).toBe(500);
    const raw = await response.text();
    // Asserted against the RAW body, not the parsed object: the exception name and
    // the pool id must not travel even in a field nobody reads.
    expect(raw).not.toContain("TooManyRequestsException");
    expect(raw).not.toContain(config.cognitoUserPoolId);

    await app.close();
  });
});

describe("GET /api/v1/admin/users", () => {
  it("joins the Cognito page to the profile rows in ONE BatchGetItem", async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser({ sub: "sub-1", email: "a@b.com" }),
        cognitoUser({ sub: "sub-2", email: "b@b.com" }),
      ],
    });
    dynamo.on(BatchGetCommand).resolves({
      Responses: {
        [TABLE]: [
          profileItem({ sub: "sub-1", sessionsConducted: 2 }),
          profileItem({ sub: "sub-2", unlimitedAccess: true }),
        ],
      },
    });

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/users`);
    const body = usersBody(await response.json());

    expect(response.status).toBe(200);
    expect(body.users).toHaveLength(2);
    // One round trip for the page, not one per row. At a 60-row page that is the
    // difference between one call and sixty.
    expect(dynamo.commandCalls(BatchGetCommand)).toHaveLength(1);

    await app.close();
  });

  it("never asks DynamoDB for resumeText", async () => {
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [cognitoUser({ sub: "sub-1", email: "a@b.com" })] });
    dynamo
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [profileItem({ sub: "sub-1" })] } });

    const app = await serve();
    await fetch(`${app.url}${PATH}/users`);

    const request =
      dynamo.commandCalls(BatchGetCommand)[0]?.args[0]?.input.RequestItems?.[
        TABLE
      ];

    // The admin table has no use for a single character of it, and at a 60-row
    // page it is over a megabyte of redacted resume crossing the wire to render a
    // quota column.
    expect(request?.ProjectionExpression).not.toContain("resumeText");
    expect(
      Object.values(request?.ExpressionAttributeNames ?? {}),
    ).not.toContain("resumeText");

    await app.close();
  });

  it("aliases every projected name, not just the reserved-looking ones", async () => {
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [cognitoUser({ sub: "sub-1", email: "a@b.com" })] });
    dynamo
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [profileItem({ sub: "sub-1" })] } });

    const app = await serve();
    await fetch(`${app.url}${PATH}/users`);

    const projection =
      dynamo.commandCalls(BatchGetCommand)[0]?.args[0]?.input.RequestItems?.[
        TABLE
      ]?.ProjectionExpression ?? "";

    // Structural, because aws-sdk-client-mock does NOT validate against DynamoDB's
    // reserved-word list — it accepts a bare `status` and real DynamoDB rejects the
    // request. Asserting "no token lacks a #" is the only form a new field cannot
    // escape. `depth` and `role` have each taken down a query in this codebase this
    // exact way.
    for (const token of projection.split(", ")) {
      expect(token.startsWith("#")).toBe(true);
    }

    await app.close();
  });

  it("reports an account with no profile as null rather than omitting it", async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser({ sub: "sub-1", email: "a@b.com" }),
        cognitoUser({ sub: "sub-nope", email: "new@b.com" }),
      ],
    });
    // BatchGetItem omits misses rather than reporting them, which is how an
    // un-onboarded account presents.
    dynamo
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [profileItem({ sub: "sub-1" })] } });

    const app = await serve();
    const body = usersBody(
      await (await fetch(`${app.url}${PATH}/users`)).json(),
    );

    const rows = body.users;
    // Signed up and never onboarded is a real state and the one an operator most
    // often wants to see. Dropping the row would make the table disagree with
    // Cognito's own user count.
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.email === "new@b.com")?.profile).toBeNull();

    await app.close();
  });

  it("carries the Cognito username, which is not the sub for a federated user", async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser({
          sub: "sub-1",
          email: "a@b.com",
          username: "google_109371234",
        }),
      ],
    });
    dynamo
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [profileItem({ sub: "sub-1" })] } });

    const app = await serve();
    const body = usersBody(
      await (await fetch(`${app.url}${PATH}/users`)).json(),
    );

    // Carried because it is what AdminDeleteUser and admin-add-user-to-group take.
    // An operator copying a value out of this table must copy one that works.
    expect(body.users[0]?.username).toBe("google_109371234");
    expect(body.users[0]?.userId).toBe("sub-1");

    await app.close();
  });

  it("passes Cognito's pagination token back as an opaque cursor", async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [cognitoUser({ sub: "sub-1", email: "a@b.com" })],
      PaginationToken: "opaque-token",
    });
    dynamo
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [profileItem({ sub: "sub-1" })] } });

    const app = await serve();
    const body = usersBody(
      await (await fetch(`${app.url}${PATH}/users`)).json(),
    );

    expect(body.nextCursor).toBe("opaque-token");

    await app.close();
  });

  it("reports the last page as a null cursor, never an empty string", async () => {
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [cognitoUser({ sub: "sub-1", email: "a@b.com" })] });
    dynamo
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [profileItem({ sub: "sub-1" })] } });

    const app = await serve();
    const body = usersBody(
      await (await fetch(`${app.url}${PATH}/users`)).json(),
    );

    // An empty string would pass the client's `!== undefined` check and come back
    // as a cursor the server then rejects with a 400.
    expect(body.nextCursor).toBeNull();

    await app.close();
  });

  it("forwards a supplied cursor to Cognito", async () => {
    cognito
      .on(ListUsersCommand)
      .resolves({ Users: [cognitoUser({ sub: "sub-9", email: "z@b.com" })] });
    dynamo.on(BatchGetCommand).resolves({ Responses: { [TABLE]: [] } });

    const app = await serve();
    await fetch(`${app.url}${PATH}/users?cursor=page-two`);

    expect(
      cognito.commandCalls(ListUsersCommand)[0]?.args[0]?.input.PaginationToken,
    ).toBe("page-two");

    await app.close();
  });

  it("skips a directory entry missing its sub rather than failing the page", async () => {
    cognito.on(ListUsersCommand).resolves({
      Users: [
        // No Attributes at all — cannot be joined to a profile and cannot be
        // looked up again, so there is nothing an operator could do with the row.
        { Username: "broken", Enabled: true, UserStatus: "CONFIRMED" },
        cognitoUser({ sub: "sub-1", email: "a@b.com" }),
      ],
    });
    dynamo
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE]: [profileItem({ sub: "sub-1" })] } });

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/users`);
    const body = usersBody(await response.json());

    // Dropping one unusable row beats failing the page and hiding the other 59.
    expect(response.status).toBe(200);
    expect(body.users).toHaveLength(1);
    expect(body.users[0]?.userId).toBe("sub-1");

    await app.close();
  });

  it("does not call DynamoDB at all when Cognito returns an empty page", async () => {
    cognito.on(ListUsersCommand).resolves({ Users: [] });

    const app = await serve();
    const body = usersBody(
      await (await fetch(`${app.url}${PATH}/users`)).json(),
    );

    expect(body.users).toEqual([]);
    // A BatchGetItem with zero keys is a validation error, not an empty result.
    expect(dynamo.commandCalls(BatchGetCommand)).toHaveLength(0);

    await app.close();
  });

  it("is refused for a non-admin with a 404", async () => {
    const app = await serve({
      id: "candidate",
      username: "c@b.com",
      groups: [],
    });

    const response = await fetch(`${app.url}${PATH}/users`);

    expect(response.status).toBe(404);
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);

    await app.close();
  });
});

// An email that names more than one Cognito account.
//
// Not hypothetical and not rare: attaching a federated identity provider makes it
// routine. Signing in with Google mints a SEPARATE user carrying the same email as
// an existing native account, and a live pool for this project has exactly that
// pair. The first version of this route logged a warning and granted to whichever
// user Cognito returned first — a silent coin flip over whose quota changed, in a
// write the operator believed they had aimed precisely.
describe("POST /api/v1/admin/unlimited-access with an ambiguous email", () => {
  const duplicates = {
    Users: [
      cognitoUser({
        sub: "sub-native",
        email: "dup@example.com",
        username: "dup@example.com",
      }),
      cognitoUser({
        sub: "sub-google",
        email: "dup@example.com",
        username: "Google_116617208883325840695",
      }),
    ],
  };

  async function grantByEmail(app: MountedApp) {
    return fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dup@example.com", unlimitedAccess: true }),
    });
  }

  it("refuses with 409 rather than granting to the first match", async () => {
    cognito.on(ListUsersCommand).resolves(duplicates);

    const app = await serve();
    const response = await grantByEmail(app);

    expect(response.status).toBe(409);
    expect(failureBody(await response.json()).message).toBe(
      MESSAGES.ADMIN_USER_AMBIGUOUS,
    );

    await app.close();
  });

  it("writes NOTHING when the identifier is ambiguous", async () => {
    // The assertion that matters most. A 409 that had already written would be
    // worse than the original bug: the operator sees a failure and the grant
    // landed anyway, on an account nobody chose.
    cognito.on(ListUsersCommand).resolves(duplicates);

    const app = await serve();
    await grantByEmail(app);

    expect(dynamo.commandCalls(UpdateCommand)).toHaveLength(0);
    await app.close();
  });

  it("returns every candidate username so the retry is possible", async () => {
    cognito.on(ListUsersCommand).resolves(duplicates);

    const app = await serve();
    const response = await grantByEmail(app);
    const body = await response.json();

    // Usernames, not subs: a username is what the retry takes and what the
    // accounts table shows. Returning subs would name the accounts without
    // giving the operator anything they could paste back.
    if (typeof body !== "object" || body === null) throw new Error("bad body");
    const usernames = (body as { usernames?: unknown }).usernames;
    expect(usernames).toEqual([
      "dup@example.com",
      "Google_116617208883325840695",
    ]);

    await app.close();
  });

  it("grants correctly when the operator retries by username", async () => {
    // The disambiguated path. Only one user matches a username, so the lookup
    // resolves and the write goes to that sub and no other.
    cognito.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser({
          sub: "sub-google",
          email: "dup@example.com",
          username: "Google_116617208883325840695",
        }),
      ],
    });
    dynamo
      .on(UpdateCommand)
      .resolves({ Attributes: profileItem({ sub: "sub-google" }) });

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Google_116617208883325840695",
        unlimitedAccess: true,
      }),
    });

    expect(response.status).toBe(200);

    // Filtered on `username`, not `email` — a username filter on the email
    // attribute would match nothing and 404 a perfectly good retry.
    expect(
      cognito.commandCalls(ListUsersCommand)[0]?.args[0]?.input.Filter,
    ).toBe('username = "Google_116617208883325840695"');

    expect(dynamo.commandCalls(UpdateCommand)[0]?.args[0]?.input.Key).toEqual({
      PK: userPk("sub-google"),
      SK: SORT_KEY.PROFILE,
    });

    await app.close();
  });

  it("does not lowercase a username, unlike an email", async () => {
    // Cognito usernames are case-sensitive and the federated form carries a
    // capital G. Folding it — which the email path deliberately does — turns a
    // valid retry into a 404.
    cognito.on(ListUsersCommand).resolves({ Users: [] });

    const app = await serve();
    await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Google_ABC123",
        unlimitedAccess: true,
      }),
    });

    expect(
      cognito.commandCalls(ListUsersCommand)[0]?.args[0]?.input.Filter,
    ).toContain("Google_ABC123");

    await app.close();
  });

  it("echoes which identity was actually written to", async () => {
    // On a pool where an email can name two accounts, a reply confirming only
    // the email confirms nothing about where the grant landed.
    cognito.on(ListUsersCommand).resolves({
      Users: [
        cognitoUser({
          sub: "sub-google",
          email: "dup@example.com",
          username: "Google_116617208883325840695",
        }),
      ],
    });
    dynamo
      .on(UpdateCommand)
      .resolves({ Attributes: profileItem({ sub: "sub-google" }) });

    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Google_116617208883325840695",
        unlimitedAccess: true,
      }),
    });

    expect(accessBody(await response.json()).username).toBe(
      "Google_116617208883325840695",
    );
    await app.close();
  });

  it("400s a body carrying both an email and a username", async () => {
    // Both is as wrong as neither. If they disagree the route would have to pick
    // one, and picking silently is the entire class of bug being closed here.
    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "a@b.com",
        username: "Google_1",
        unlimitedAccess: true,
      }),
    });

    expect(response.status).toBe(400);
    expect(cognito.commandCalls(ListUsersCommand)).toHaveLength(0);
    await app.close();
  });

  it("400s a body carrying neither", async () => {
    const app = await serve();
    const response = await fetch(`${app.url}${PATH}/unlimited-access`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ unlimitedAccess: true }),
    });

    expect(response.status).toBe(400);
    await app.close();
  });
});
