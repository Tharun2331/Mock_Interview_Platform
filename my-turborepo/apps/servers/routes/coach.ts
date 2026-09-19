import { Router } from "express";
import {
  CoachReportSchema,
  coachCacheStamp,
  isCachedCoachFresh,
  type CachedCoach,
} from "@repo/shared";
import { runCoachAgent } from "../agents/coach";
import { ServiceError } from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { listUserSessionSummaries } from "../lib/evaluations";
import { getCachedCoach, putCachedCoach } from "../lib/profile";

export const coachRouter = Router();

// GET /api/v1/coach
//
// Every finished interview a candidate has, read as one Query, turned into a
// trend line per topic and a study roadmap.
//
// ONE READ, and that is worth explaining because the obvious implementation is
// not. Evaluations live under SESSION#<sid> with nothing on them naming a user,
// so "every evaluation for this candidate" is not a query — it is their session
// list followed by a Query per session, pulling every rationale to compute
// three means. The USER#<uid>/SUMMARY#<completedAt> rows are the denormalised
// answer: one row per finished interview, written once at completion, already
// ordered by date because the timestamp is the sort key.
//
// TOPIC is the target role. It is the only subject label these rows carry, and
// it is also what a candidate actually varies between sessions. Anything finer
// — per focus area, per question type — is not expressible from stored data
// today: questionType lives on ANSWER# items and focusAreas on the plan, so
// either would reintroduce the per-session fan-out this route avoids. If that
// resolution is wanted, the fix is to carry a per-dimension breakdown by
// question type onto the summary row at completion, the same way `averages`
// now is.
//
// CACHED at USER#<uid>/COACH, holding the model's prose only.
//
// A DynamoDB item, not Redis and not a Cache-Control header. Redis is not in
// this stack — ADR-0006 — and an HTTP header cannot express this cache's
// freshness rule, which is not a duration: a report is valid until the
// candidate's history changes and indefinitely if it does not. It is also a
// server-side cache whose entire purpose is skipping a Bedrock call, which a
// browser cache cannot do.
//
// Only the prose is stored. Every number is recomputed here from rows this
// handler had to read anyway, so a repaired or backfilled row is reflected
// immediately rather than waiting for the candidate's next interview.
coachRouter.get("/", async (req, res) => {
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return;
  }

  try {
    const summaries = await listUserSessionSummaries({ userId });

    // Computed from the rows just read, so the freshness check costs no extra
    // request — the property that makes this cache free to consult.
    const stamp = coachCacheStamp(summaries);

    // A read failure degrades to a miss rather than a 500. The cache exists to
    // save money, and losing it should cost a Bedrock call, not the page.
    let cached: CachedCoach | null = null;
    try {
      cached = await getCachedCoach({ userId });
    } catch (error) {
      console.warn(
        `[coach] cache read failed, regenerating — ${
          error instanceof Error ? error.message : "unknown"
        }`
      );
    }

    const fresh =
      cached !== null && isCachedCoachFresh({ cached, stamp })
        ? cached.prose
        : null;

    // A candidate with no finished interviews gets an empty report rather than
    // a 404. There is no error here — they simply have not done one yet, and
    // the page has an empty state for exactly this.
    const result = await runCoachAgent({ summaries, cachedProse: fresh });

    // Only a run that actually generated something is worth writing. Rewriting
    // on a hit would be a Put per page load to store bytes already there.
    if (result.generated && result.prose !== null) {
      try {
        await putCachedCoach({ userId, prose: result.prose, stamp });
      } catch (error) {
        // The report is already built. Failing the response because it could
        // not be filed away would turn a saved cost into a lost page.
        console.warn(
          `[coach] cache write failed, report still served — ${
            error instanceof Error ? error.message : "unknown"
          }`
        );
      }
    }

    res.json(CoachReportSchema.parse(result.report));
  } catch (error) {
    if (error instanceof ServiceError) {
      console.error(`[coach] ${error.message}`);
      res.status(500).json({ message: MESSAGES.SESSION_UNAVAILABLE });
      return;
    }

    // No 502 branch, unlike /gap. The agent cannot fail on the model — a failed
    // generation degrades to numbers without prose inside it — so anything
    // reaching here is ours: the read, or a bug in the analysis.
    console.error(`[coach] ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
  }
});
