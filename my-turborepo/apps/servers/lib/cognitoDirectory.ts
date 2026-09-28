import {
  ListUsersCommand,
  type UserType,
} from "@aws-sdk/client-cognito-identity-provider";
import { config } from "./config";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";
import { cognitoAdminClient } from "./cognitoAdmin";

// Reads the Cognito directory. The admin surface's answer to "who are my users"
// and "which account owns this email".
//
// **Why Cognito and not a DynamoDB index.** The original plan for this was a GSI
// on an `email` attribute of the PROFILE item. That is not buildable against this
// data model without first changing it: `UserProfileSchema` has never stored an
// email — Cognito owns it, as the pool's `username_attributes` — so a GSI would
// have meant adding the field, writing it on every profile upsert, backfilling
// every existing account out of Cognito, and only then indexing. The index would
// also have been a second copy of the largest item in the table, since the
// profile carries `resumeText`.
//
// Cognito already answers both questions exactly, with no new stored field and
// nothing to keep in sync. The listing question is the stronger argument: there
// is no keyed way to enumerate every user on the base table, so GET /admin/users
// against DynamoDB would be a Scan — which the task role deliberately does not
// grant, on the grounds that a Scan on that table is a bug that bills like a
// feature.
//
// What this costs instead: one Cognito API call per admin request, on a service
// whose request pricing is nil at this volume, and `cognito-idp:ListUsers` on the
// API role scoped to the one pool.
//
// Reuses `cognitoAdminClient` rather than constructing a second client, so both
// admin paths share one connection pool and one credential chain — and so the
// verifier in lib/cognitoAuth.ts stays the module with no AWS credentials at all.

// One directory entry, with the SDK's pervasive optionality already resolved.
// Every field is required here: an entry that cannot produce one is dropped
// rather than surfaced half-populated, because a row with no subject cannot be
// joined to a profile and a row with no email cannot be looked up again.
export type DirectoryUser = {
  // The Cognito `sub`. This is what keys every DynamoDB item.
  userId: string;
  // The Cognito username, which is NOT the sub for a federated account — those
  // look like `google_10937...`. Carried because it is what the Admin* APIs take.
  username: string;
  email: string;
  enabled: boolean;
  status: string;
  createdAt: string;
};

function attribute(user: UserType, name: string): string | undefined {
  return user.Attributes?.find((entry) => entry.Name === name)?.Value;
}

// Returns null for an entry missing anything the admin surface needs to act on
// it, rather than widening DirectoryUser to make every field optional.
//
// The SDK types every one of these as optional because the wire shape allows it,
// not because Cognito omits them in practice — `sub`, `email` and `UserStatus`
// are always present on a real user in an email-alias pool. Dropping the
// unparseable row keeps that optionality out of every caller, at the cost of a
// user silently missing from the table; the count mismatch that would cause is
// why this logs.
function toDirectoryUser(user: UserType): DirectoryUser | null {
  const userId = attribute(user, "sub");
  const email = attribute(user, "email");
  const {
    Username: username,
    UserStatus: status,
    UserCreateDate: created,
  } = user;

  if (
    userId === undefined ||
    email === undefined ||
    username === undefined ||
    status === undefined ||
    created === undefined
  ) {
    console.warn(
      `[admin] skipped a Cognito entry missing required attributes — ` +
        `username=${username ?? "?"} sub=${userId ?? "?"}`,
    );
    return null;
  }

  return {
    userId,
    username,
    email,
    // Absent means enabled in the API's own default, but Cognito populates it on
    // every real user. `?? true` rather than `?? false` so a directory read that
    // loses this field cannot make every account look suspended.
    enabled: user.Enabled ?? true,
    status,
    createdAt: created.toISOString(),
  };
}

// Cognito's ListUsers filter is a tiny query language, and its string literals
// are double-quoted with no documented escape. A `"` in the value therefore ends
// the literal early and the remainder is parsed as filter syntax.
//
// `AdminAccessBody` already runs the input through `z.email()`, which no quote or
// backslash survives, so this is the second gate rather than the only one. It is
// here anyway because the validation lives in a different package from the call,
// and a future caller reaching `findUserByEmail` directly would not pass through
// it. Refusing beats escaping: there is no escape to get right, and no legitimate
// email contains either character outside a quoted local part nobody uses.
const FILTER_UNSAFE = /["\\]/;

// The outcome of resolving one identifier to one account.
//
// Three cases, not two, and the third is the whole point. An earlier version
// returned `DirectoryUser | null` and, on multiple matches, logged a warning and
// took the first — reasoning that email is the pool's username alias so Cognito
// enforces uniqueness. **That reasoning is wrong the moment a federated identity
// provider is attached.** Signing in with Google mints a separate user carrying
// the same email as an existing native account, and a live pool here has exactly
// that pair. So "first match" is a coin flip between two real people's quotas,
// decided silently, in a write the operator believes they aimed precisely.
export type DirectoryLookup =
  | { kind: "found"; user: DirectoryUser }
  | { kind: "none" }
  // Carries the usernames rather than a count, because the caller's next step is
  // to pick one, and a username is what the retry takes.
  | { kind: "ambiguous"; usernames: string[] };

// Resolves an email OR a Cognito username to exactly one account.
//
// `=` in a ListUsers filter is an exact comparison — not a prefix match and not a
// case fold. Email is lowercased by `AdminAccessBody` before it arrives; username
// deliberately is NOT, because Cognito usernames are case-sensitive and the
// federated form is `Google_1033...` with a capital G.
//
// Refuses rather than guesses when an email matches more than one identity. The
// cost is that the operator has to look at the accounts table and copy a username;
// the alternative is granting a stranger unlimited interviews and telling nobody.
export async function findDirectoryUser(args: {
  email?: string;
  username?: string;
}): Promise<DirectoryLookup> {
  const attribute = args.email !== undefined ? "email" : "username";
  const value = args.email ?? args.username;

  if (value === undefined) {
    throw new ServiceError(
      `${MESSAGES.ADMIN_DIRECTORY_FAILED} — a lookup needs an email or a username`,
    );
  }

  if (FILTER_UNSAFE.test(value)) {
    throw new ServiceError(
      `${MESSAGES.ADMIN_DIRECTORY_FAILED} — refusing a lookup on a value ` +
        `containing a quote or backslash`,
    );
  }

  let response;
  try {
    response = await cognitoAdminClient.send(
      new ListUsersCommand({
        UserPoolId: config.cognitoUserPoolId,
        Filter: `${attribute} = "${value}"`,
        // More than the two an "is it unique" check would need, so the ambiguous
        // branch can report every candidate rather than "at least two". An
        // operator picking between identities wants the whole list.
        Limit: 10,
      }),
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.ADMIN_DIRECTORY_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }

  const users = (response.Users ?? [])
    .map(toDirectoryUser)
    .filter((user): user is DirectoryUser => user !== null);

  if (users.length === 0) return { kind: "none" };

  if (users.length > 1) {
    console.warn(
      `[admin] ${users.length} accounts match ${attribute}=${value} — ` +
        `refusing to guess: ${users.map((u) => u.username).join(", ")}`,
    );
    return { kind: "ambiguous", usernames: users.map((u) => u.username) };
  }

  const only = users[0];
  // Unreachable given the length checks above; narrows without a non-null
  // assertion, which CLAUDE.md forbids.
  if (only === undefined) return { kind: "none" };

  return { kind: "found", user: only };
}

// One page of the directory, newest pagination token passed straight back.
//
// Deliberately not "every user": ListUsers pages at 60, and a route that looped
// until exhaustion would turn one admin page load into an unbounded number of
// Cognito calls and hold the request open for all of them. The client pages.
//
// Cognito does not sort ListUsers and does not document an order, so the table's
// order is whatever the directory returns. Not worth fixing here — sorting a page
// would sort within the page only, which is more misleading than no sort at all.
export async function listDirectoryUsers(args: {
  cursor?: string;
}): Promise<{ users: DirectoryUser[]; nextCursor: string | null }> {
  let response;
  try {
    response = await cognitoAdminClient.send(
      new ListUsersCommand({
        UserPoolId: config.cognitoUserPoolId,
        Limit: config.adminUserPageSize,
        PaginationToken: args.cursor,
      }),
    );
  } catch (error) {
    throw new ServiceError(
      `${MESSAGES.ADMIN_DIRECTORY_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`,
    );
  }

  const users = (response.Users ?? [])
    .map(toDirectoryUser)
    .filter((user): user is DirectoryUser => user !== null);

  return {
    users,
    // Normalised to null. Cognito returns the field absent on the last page and
    // an empty string is not a documented value, but `?? null` on a falsy token
    // would let "" through as a cursor that then fails the next request.
    nextCursor:
      response.PaginationToken !== undefined &&
      response.PaginationToken.length > 0
        ? response.PaginationToken
        : null,
  };
}
