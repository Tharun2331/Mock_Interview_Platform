import { Router } from "express";
import { z } from "zod";
import { ServiceError, SessionAccessError, SessionStateError } from "../lib/errors";
import { loadSessionEvaluations } from "../lib/evaluations";
import { MESSAGES } from "../lib/messages";

// Read paths for a finished interview.
//
// Uses the `/api/v1/sessions/:sessionId/...` shape that api.md §3 has specified
// all along. The routes built before this one are flat (`/profile`, `/plan`),
// which api.md §1 records as the divergence — this is the first piece of the
// documented shape to actually exist, and `/coach` joins it in Phase 6.

export const sessionsRouter = Router();

// Path parameters are validated like any other input. A session id is a ULID
// written by the server, so anything that is not one cannot name a real session
// and is rejected before it reaches a key expression.
const SessionIdParams = z.object({
  sessionId: z.string().min(1).max(64),
});

// Polled while the worker drains the queue, so the failure mapping matters more
// than usual: a client that retries on the wrong status either spins forever or
// gives up on a session that was still working.
function handleFailure(res: import("express").Response, error: unknown): void {
  // Unknown session and someone else's session are deliberately the same
  // response — the status must not confirm that an id exists.
  if (error instanceof SessionAccessError) {
    res.status(404).json({ message: error.message });
    return;
  }

  // The session exists and is theirs, but has not reached a state with results.
  // 409 rather than 404 so the client can tell "not yet" from "never".
  if (error instanceof SessionStateError) {
    res.status(409).json({ message: error.message });
    return;
  }

  if (error instanceof ServiceError) {
    console.error(`[sessions] ${error.message}`);
    res.status(500).json({ message: MESSAGES.SESSION_UNAVAILABLE });
    return;
  }

  console.error(`[sessions] ${error instanceof Error ? error.message : error}`);
  res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
}

// Partial results as they land. A candidate reads the first three scores while
// the rest are still queued, which is the point of scoring asynchronously.
//
// `averages` appearing is the signal the round is finished — the client stops
// polling on that rather than on a count, because the count is only meaningful
// against a total the same response carries.
sessionsRouter.get("/:sessionId/evaluation", async (req, res) => {
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return;
  }

  const params = SessionIdParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ message: MESSAGES.INVALID_SESSION_ID });
    return;
  }

  try {
    // Ownership is proven inside, against the session's own userId — never
    // against anything in the path.
    const results = await loadSessionEvaluations({
      sessionId: params.data.sessionId,
      userId,
    });

    res.json(results);
  } catch (error) {
    handleFailure(res, error);
  }
});
