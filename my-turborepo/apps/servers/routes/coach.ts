import { Router } from "express";
import { CoachReportSchema } from "@repo/shared";
import { runCoachAgent } from "../agents/coach";
import { ServiceError } from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { listUserSessionSummaries } from "../lib/evaluations";

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
// No caching. The report is regenerated per request, which is one Bedrock call
// per page load — see the note in the route below.
coachRouter.get("/", async (req, res) => {
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return;
  }

  try {
    const summaries = await listUserSessionSummaries({ userId });

    // A candidate with no finished interviews gets an empty report rather than
    // a 404. There is no error here — they simply have not done one yet, and
    // the page has an empty state for exactly this.
    const report = await runCoachAgent({ summaries });

    res.json(CoachReportSchema.parse(report));
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
