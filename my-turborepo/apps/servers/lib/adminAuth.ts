import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { MESSAGES } from "./messages";

// The single admin check. Every /admin route mounts behind this one middleware
// rather than testing membership in its own handler — a per-handler check is a
// per-handler chance to forget one, and the route that forgets is by definition
// the one nobody tested.
//
// Mounted AFTER AuthMiddleware, never instead of it. This function makes no
// trust decision of its own: it reads `req.user.groups`, which only the verifier
// in lib/cognitoAuth.ts writes, from a claim on a signature-checked token. On its
// own — mounted without AuthMiddleware in front — it refuses everything, because
// `req.user` is undefined. That is the correct failure for a mounting mistake,
// and it is why the guard below treats a missing user the same as a wrong group.
//
// Returns 404, not 403, and not 401.
//
// A 403 would confirm to any signed-in candidate that this route exists, which
// is the one thing an admin surface should not advertise: it turns "is there an
// admin API" into a settled question and names the path. A 401 would be worse
// still — it invites a client to refresh a perfectly valid token and retry. The
// 404 is byte-identical to what an unrouted path returns, so probing /admin
// tells an attacker exactly what probing /adminn does. Same reasoning
// SessionAccessError carries for not distinguishing "no such session" from "not
// yours".
//
// The cost of that choice is real and worth naming: an admin who is genuinely
// missing from the group also sees a 404 and has no way to tell it from a typo
// in the URL. That is why the refusal is logged with the subject below — the
// server log is where an operator finds out, because the response deliberately
// will not tell them.
export const RequireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const user = req.user;

  if (user === undefined || !user.groups.includes(config.adminGroupName)) {
    // Logged at warn rather than dropped. A refusal here is either a mounting
    // mistake, a missing group membership, or someone probing — all three are
    // worth a line, and the response says nothing. The subject is logged and the
    // token is not; `id` is already what every other log line in this service
    // keys on.
    console.warn(
      `[admin] refused ${req.method} ${req.originalUrl} for ` +
        `${user?.id ?? "unauthenticated"} — not in group ` +
        `"${config.adminGroupName}"`,
    );
    res.status(404).json({ message: MESSAGES.NOT_FOUND });
    return;
  }

  next();
};

// Narrows `req.user` for an admin handler, which needs the subject for logging.
//
// AuthMiddleware and RequireAdmin have both run by the time a handler calls
// this, so the undefined branch is unreachable in a correctly mounted router.
// It exists because the type says it can happen and CLAUDE.md forbids `!` —
// and because "unreachable" is a claim about the mounting, which lives in a
// different file and can change without this one being touched.
export function requireAdminId(req: Request, res: Response): string | null {
  const id = req.user?.id;
  if (id === undefined) {
    res.status(404).json({ message: MESSAGES.NOT_FOUND });
    return null;
  }
  return id;
}
