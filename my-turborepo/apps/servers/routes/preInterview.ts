import { ulid } from "ulid";
import { Router } from "express";
import { isProfileComplete } from "@repo/shared";
import {
  ProfileStateError,
  ServiceError,
} from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { getProfile } from "../lib/profile";
import { createSession } from "../lib/sessions";

// Starts an interview session from the candidate's stored profile.
//
// This route used to do the ingestion itself: upload a PDF, parse it, scrape
// GitHub and create a session, all in one multipart request, once per
// interview. It is the same resume every time, so that work moved to
// POST /api/v1/profile/resume and happens once. What is left here is the part
// that is genuinely per-interview — minting a session and snapshotting the
// material it will be planned against.
//
// Consequences of the move:
//   - No multipart. The body is empty; everything comes from the profile.
//   - No GitHub call, so the route no longer depends on an upstream that
//     rate-limits, and a candidate with a stale scrape refreshes it by saving
//     their profile rather than by starting an interview.
//   - The resume text copied into INPUTS is REDACTED, because that is the only
//     form the profile stores. Raw resume text no longer reaches DynamoDB.

export const preInterviewRouter = Router();

preInterviewRouter.post("/", async (req, res) => {
  // ULID, not UUID. The id becomes the `SESSION#<sid>` sort-key suffix in the
  // user-history item, and ULIDs sort lexicographically by creation time — so a
  // Query returns a candidate's sessions oldest-first with no sort attribute and
  // no client-side sort. A v4 UUID would return them in random order.
  const sessionId = ulid();

  // AuthMiddleware guarantees req.user; the guard narrows the optional type.
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return;
  }

  try {
    const profile = await getProfile({ userId });

    // 409 rather than 400: nothing is wrong with the request, the account is
    // just not ready. The client's onboarding guard should have prevented this,
    // so reaching it means the guard was bypassed or the profile was cleared in
    // another tab — either way the fix is to finish onboarding, not to retry.
    if (profile === null || !isProfileComplete(profile)) {
      res.status(409).json({ message: MESSAGES.PROFILE_INCOMPLETE });
      return;
    }

    // isProfileComplete has already proven both are present; these narrow the
    // optional types without a non-null assertion.
    const { resumeKey, resumeText } = profile;
    if (resumeKey === undefined || resumeText === undefined) {
      res.status(409).json({ message: MESSAGES.PROFILE_INCOMPLETE });
      return;
    }

    // Copied into the session rather than read from the profile at plan time,
    // deliberately. INPUTS is a snapshot: an interview was conducted against
    // the material as it stood when it started, and a candidate who updates
    // their resume next month must not retroactively change what a past session
    // was scored against. `profileVersion` records which snapshot this is.
    await createSession({
      sessionId,
      userId,
      resumeKey,
      resumeText,
      repos: profile.repos,
      githubUsername: profile.githubUsername ?? null,
      profileVersion: profile.profileVersion,
    });

    res.json({ sessionId });
  } catch (error) {
    if (error instanceof ProfileStateError) {
      res.status(409).json({ message: error.message });
      return;
    }

    // The candidate's material is safe in their profile either way — only the
    // session record failed — so this is worth retrying and says so.
    if (error instanceof ServiceError) {
      console.error(`[pre-interview] ${error.message}`);
      res.status(500).json({ message: MESSAGES.SESSION_UNAVAILABLE });
      return;
    }

    console.error(
      `[pre-interview] ${error instanceof Error ? error.message : error}`
    );
    res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
  }
});
