import { Router, type Response } from "express";
import {
  AdminAccessBody,
  AdminUsersQuery,
  resolveSessionAllowance,
  type AdminAccessResponse,
  type AdminUserRow,
  type AdminUsersResponse,
} from "@repo/shared";
import { requireAdminId } from "../lib/adminAuth";
import { findDirectoryUser, listDirectoryUsers } from "../lib/cognitoDirectory";
import { ServiceError } from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { getAdminProfiles, setAccessGrant } from "../lib/profile";

// The admin surface. Two user-management routes here; GET /metrics lives in
// routes/adminMetrics.ts, mounted on the same path behind the same guard.
//
// **This router assumes RequireAdmin is in front of it and does not check again.**
// That is the point of the middleware — a per-handler check is a per-handler
// chance to forget one. The mounting in index.ts is the enforcement, and it is
// `AuthMiddleware, RequireAdmin` in that order: the group claim only exists after
// a token has been verified.
//
// Failure copy here is admin-facing, which inverts the usual rule in this
// codebase. Everywhere else a route hides dependency detail from the client
// because the client is a candidate who can do nothing with it. The only client
// here is the operator, so these responses name the actual problem — "no account
// with that email", "that account never onboarded" — while genuine AWS failures
// still keep their detail in the log rather than the body, because an AWS
// exception message is not information either.

export const adminRouter = Router();

// Shared failure mapping. ServiceError is the only typed error the two handlers
// below can raise — lib/cognitoDirectory and lib/profile both wrap AWS failures
// in it — so a 500 with the generic copy is the honest answer to all of them.
function handleFailure(res: Response, error: unknown): void {
  if (error instanceof ServiceError) {
    console.error(`[admin] ${error.message}`);
    res.status(500).json({ message: MESSAGES.ADMIN_UNAVAILABLE });
    return;
  }

  console.error(`[admin] ${error instanceof Error ? error.message : error}`);
  res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
}

// POST /api/v1/admin/unlimited-access
//
// Grants or revokes the interview quota override. One route for both, because
// they are the same write with a different payload and splitting them would mean
// two handlers doing the same email resolution.
//
// Named for the flag rather than for what it does to be greppable against the
// attribute, but it sets a NUMBER as well: `{ unlimitedAccess: false }` alone
// revokes to the default 3, and `{ unlimitedAccess: false, sessionLimit: 10 }`
// grants ten. See AccessGrantSchema for why those are two fields.
adminRouter.post("/unlimited-access", async (req, res) => {
  const adminId = requireAdminId(req, res);
  if (adminId === null) return;

  const parsed = AdminAccessBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      message: MESSAGES.INVALID_ADMIN_BODY,
      // Issues are echoed because the caller is the operator and a rejected
      // `sessionLimit: 5000` should say it exceeded the ceiling rather than
      // "invalid". Zod's paths and messages carry no server internals.
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
    return;
  }

  const { email, username, unlimitedAccess, sessionLimit } = parsed.data;

  try {
    // Cognito first: the identifier has to become a subject before DynamoDB can be
    // addressed at all, since every item keys on the sub.
    const lookup = await findDirectoryUser({ email, username });

    if (lookup.kind === "none") {
      res.status(404).json({ message: MESSAGES.ADMIN_USER_NOT_FOUND });
      return;
    }

    // 409, and nothing is written.
    //
    // Two Cognito identities share this email — a native account and a federated
    // one, which is what happens when someone signs up with a password and later
    // signs in with Google. Picking either would be a silent coin flip over whose
    // quota changes, so the operator is handed the candidates and asked to name
    // one. The usernames travel in the body because copying one back is the retry.
    if (lookup.kind === "ambiguous") {
      console.warn(
        `[admin] ${adminId} attempted a grant on an ambiguous identifier ` +
          `(${lookup.usernames.length} matches) — refused`,
      );
      res.status(409).json({
        message: MESSAGES.ADMIN_USER_AMBIGUOUS,
        usernames: lookup.usernames,
      });
      return;
    }

    const user = lookup.user;

    const profile = await setAccessGrant({
      userId: user.userId,
      unlimitedAccess,
      sessionLimit,
    });

    // 409, not 404. The account genuinely exists — the operator's email was
    // right — there is simply nothing to grant against until they onboard. A 404
    // here would send someone hunting for a typo that was never there.
    if (profile === null) {
      res.status(409).json({ message: MESSAGES.ADMIN_PROFILE_MISSING });
      return;
    }

    const allowance = resolveSessionAllowance({
      unlimitedAccess: profile.unlimitedAccess,
      sessionLimit: profile.sessionLimit,
      sessionsConducted: profile.sessionsConducted,
    });

    // The one audit trail this action has. There is no admin action log — a
    // deliberate scope call, not an oversight — so this line is the only record
    // that a quota changed and who changed it.
    //
    // Logs the RESOLVED identity (`user.username`), not the identifier that was
    // typed. With two Cognito identities able to share one email, "granted to
    // tsd231311@gmail.com" does not say which account changed, and that is exactly
    // the question this line will be read to answer.
    console.log(
      `[admin] ${adminId} set access for ${user.username} ` +
        `(sub=${user.userId}, ${user.email}): unlimited=${unlimitedAccess} ` +
        `limit=${sessionLimit ?? "default"} used=${allowance.used}`,
    );

    const body: AdminAccessResponse = {
      userId: user.userId,
      email: user.email,
      // Echoed so the operator can see WHICH identity was hit, not just which
      // address. On a pool where an email can name two accounts, the response
      // confirming only the email would confirm nothing.
      username: user.username,
      allowance,
    };
    res.json(body);
  } catch (error) {
    handleFailure(res, error);
  }
});

// GET /api/v1/admin/users?cursor=<opaque>
//
// One page of the directory joined to the quota fields on each profile.
//
// Cognito is the spine of the join rather than DynamoDB, because "every user" is
// only answerable there: the base table has no keyed way to enumerate accounts,
// so a DynamoDB-first listing would be a Scan — which the task role does not
// grant, deliberately. The consequence to know is that someone who signed up and
// never onboarded appears in this table with `profile: null`, which is correct
// and is the state an operator most often wants to see.
adminRouter.get("/users", async (req, res) => {
  const adminId = requireAdminId(req, res);
  if (adminId === null) return;

  const parsed = AdminUsersQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ message: MESSAGES.INVALID_ADMIN_BODY });
    return;
  }

  try {
    const { users, nextCursor } = await listDirectoryUsers({
      cursor: parsed.data.cursor,
    });

    // One BatchGetItem for the whole page rather than a GetItem per row. At a
    // 60-row page that is the difference between one round trip and sixty, and
    // the profile slice it reads deliberately omits `resumeText` — see
    // ADMIN_PROFILE_FIELDS.
    const profiles = await getAdminProfiles({
      userIds: users.map((user) => user.userId),
    });

    const rows: AdminUserRow[] = users.map((user) => {
      const profile = profiles.get(user.userId);

      return {
        userId: user.userId,
        email: user.email,
        username: user.username,
        enabled: user.enabled,
        status: user.status,
        createdAt: user.createdAt,
        profile:
          profile === undefined
            ? null
            : {
                // Coarser than `isProfileComplete` and deliberately so — the
                // projection has no `resumeText` to check. See the note on
                // ADMIN_PROFILE_FIELDS for why `resumeKey` is a safe proxy.
                complete:
                  profile.status === "active" &&
                  profile.firstName !== undefined &&
                  profile.lastName !== undefined &&
                  profile.resumeKey !== undefined,
                firstName: profile.firstName,
                lastName: profile.lastName,
                // Both counters, not just the one the quota reads. The gap
                // between them is the diagnostic: an account with 1 conducted and
                // 12 created is someone repeatedly bouncing off the interview
                // screen, and that was invisible while a single number counted
                // mints and called them interviews.
                sessionsConducted: profile.sessionsConducted,
                sessionsCreated: profile.sessionsCreated,
                unlimitedAccess: profile.unlimitedAccess,
                sessionLimit: profile.sessionLimit,
              },
      };
    });

    const body: AdminUsersResponse = { users: rows, nextCursor };
    res.json(body);
  } catch (error) {
    handleFailure(res, error);
  }
});
