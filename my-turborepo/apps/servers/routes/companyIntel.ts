import { Router } from "express";
import { INTEL_LIMITS, intelIsEmpty } from "@repo/shared";
import { z } from "zod";
import { runCompanyIntelAgent } from "../agents/companyIntel";
import {
  ServiceError,
  SessionAccessError,
  SessionStateError,
} from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { loadPlannerInputs, putCompanyIntel } from "../lib/sessions";

export const companyIntelRouter = Router();

// Classifies what the candidate already told us about the company and stores
// the result, swallowing every failure.
//
// Exists so the plan route can trigger it without taking on its failure modes,
// exactly as `analyseGap` does. The agent itself already degrades rather than
// throwing, so the only thing left to catch here is the DynamoDB write — and a
// session that cannot store its intel still has a plan, a gap analysis, and an
// interview.
export async function researchCompany(args: {
  sessionId: string;
  company: string;
  notes?: string | undefined;
}): Promise<void> {
  try {
    const intel = await runCompanyIntelAgent(args);
    await putCompanyIntel({ intel });

    // Worth logging the outcome and not just the attempt: an all-unknown
    // result is a successful run of this agent, and without saying so the log
    // reads identically to one that never ran.
    console.log(
      `[intel] ${args.sessionId} ${args.company} — style=${intel.style} focus=${intel.focus} ` +
        `seniority=${intel.seniority} sources=${intel.sourceCount}` +
        (intelIsEmpty(intel) ? " (nothing usable, interview unaffected)" : ""),
    );
  } catch (error) {
    console.error(
      `[intel] ${args.sessionId} research failed, interview runs without it — ${
        error instanceof Error ? error.message : error
      }`,
    );
  }
}

const IntelRequestSchema = z.object({
  sessionId: z.string().min(1),
  companyName: z.string().trim().min(1).max(INTEL_LIMITS.MAX_COMPANY_CHARS),
  companyNotes: z
    .string()
    .trim()
    .min(1)
    .max(INTEL_LIMITS.MAX_NOTES_CHARS)
    .optional(),
});

// Researches on demand and stores the result.
//
// Separate from the plan route for the same reason POST /gap is: a candidate
// can learn the company name after planning, or hear something from a recruiter
// the day before, and neither should mean regenerating a plan this does not
// feed.
companyIntelRouter.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return;
  }

  const parsed = IntelRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      message: MESSAGES.INVALID_INTEL_BODY,
      errors: z.flattenError(parsed.error),
    });
    return;
  }

  try {
    // Ownership proven against the session's own userId before anything is
    // researched or written, same as every other session-scoped route. This one
    // reads nothing from the session — the agent takes a company name and
    // nothing else — so the call is purely the access check.
    await loadPlannerInputs({ sessionId: parsed.data.sessionId, userId });

    const intel = await runCompanyIntelAgent({
      sessionId: parsed.data.sessionId,
      company: parsed.data.companyName,
      notes: parsed.data.companyNotes,
    });

    await putCompanyIntel({ intel });

    // 200 even when everything came back unknown. That is a successful run of
    // an agent whose honest answer is often "the candidate gave us nothing to
    // go on", and reporting it as a failure would invite a pointless retry.
    res.json(intel);
  } catch (error) {
    if (error instanceof SessionAccessError) {
      res.status(404).json({ message: error.message });
      return;
    }

    if (error instanceof SessionStateError) {
      res.status(409).json({ message: error.message });
      return;
    }

    // No 502 branch, unlike /gap. The agent cannot fail on the model — it
    // degrades to unknown inside it — so anything reaching here is ours: the
    // session read or the write.
    if (error instanceof ServiceError) {
      console.error(`[intel] ${error.message}`);
      res.status(500).json({ message: MESSAGES.SESSION_UNAVAILABLE });
      return;
    }

    console.error(`[intel] ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
  }
});
