import { Router } from "express";
import {
  GAP_LIMITS,
  type PreInterviewRepo,
} from "@repo/shared";
import { z } from "zod";
import { runGapAgent } from "../agents/gap";
import {
  BedrockError,
  ServiceError,
  SessionAccessError,
  SessionStateError,
} from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { loadPlannerInputs, putGapAnalysis } from "../lib/sessions";

export const gapRouter = Router();

// Runs the analysis and stores it, swallowing every failure.
//
// Exists so the plan route can trigger it without taking on its failure modes:
// the analysis is targeting information for an interview that has not started
// yet, and losing it costs focus rather than the session. Awaiting it would
// also put a second Bedrock call in front of a candidate already watching a
// progress bar through the first.
export async function analyseGap(args: {
  sessionId: string;
  jobDescription: string;
  resumeText: string;
  githubSummary: string;
}): Promise<void> {
  try {
    const analysis = await runGapAgent(args);
    await putGapAnalysis({ analysis });
    console.log(
      `[gap] ${args.sessionId} analysed ${analysis.requirements.length} requirements`
    );
  } catch (error) {
    console.error(
      `[gap] ${args.sessionId} analysis failed, interview will run unfocused — ${
        error instanceof Error ? error.message : error
      }`
    );
  }
}

const GapRequestSchema = z.object({
  sessionId: z.string().min(1),
  // Required here, unlike on the plan route. Asking this endpoint to analyse
  // nothing is a client bug rather than the optional-field case — the optional
  // path is "do not call this at all".
  jobDescription: z
    .string()
    .trim()
    .min(1)
    .max(GAP_LIMITS.MAX_JOB_DESCRIPTION_CHARS),
});

// The repositories as one block of text, which is the shape the agent takes.
//
// Flattened here rather than in the agent so the agent's input stays four
// plain strings — it never learns what a repo is, and a change to the scrape
// shape cannot reach it.
export function summariseRepos(repos: PreInterviewRepo[]): string {
  if (repos.length === 0) return "";

  return repos
    .map((repo) => {
      const description = repo.description ?? "";
      return description.length > 0
        ? `- ${repo.name}: ${description}`
        : `- ${repo.name}`;
    })
    .join("\n");
}

// Runs the analysis on demand and stores it.
//
// Separate from the plan route because a candidate can paste a job description
// after planning — and because the analysis is worth re-running against a
// different posting without regenerating the plan it does not feed.
gapRouter.post("/", async (req, res) => {
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return;
  }

  const parsed = GapRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      message: MESSAGES.INVALID_GAP_BODY,
      errors: parsed.error.flatten(),
    });
    return;
  }

  try {
    // Ownership is proven here, against the session's own userId — the
    // candidate's material is read from the session and never from the wire,
    // for the same reason POST /plan stopped accepting it.
    const inputs = await loadPlannerInputs({
      sessionId: parsed.data.sessionId,
      userId,
    });

    const analysis = await runGapAgent({
      sessionId: parsed.data.sessionId,
      jobDescription: parsed.data.jobDescription,
      resumeText: inputs.resumeText ?? "",
      githubSummary: summariseRepos(inputs.repos),
    });

    await putGapAnalysis({ analysis });

    res.json(analysis);
  } catch (error) {
    if (error instanceof SessionAccessError) {
      res.status(404).json({ message: error.message });
      return;
    }

    if (error instanceof SessionStateError) {
      res.status(409).json({ message: error.message });
      return;
    }

    // 502, not 500: the request was valid and the server is healthy — the
    // upstream model failed or returned something unusable twice.
    if (error instanceof BedrockError) {
      console.error(`[gap] ${error.message}`);
      res.status(502).json({ message: MESSAGES.GAP_UNAVAILABLE });
      return;
    }

    if (error instanceof ServiceError) {
      console.error(`[gap] ${error.message}`);
      res.status(500).json({ message: MESSAGES.SESSION_UNAVAILABLE });
      return;
    }

    console.error(`[gap] ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
  }
});
