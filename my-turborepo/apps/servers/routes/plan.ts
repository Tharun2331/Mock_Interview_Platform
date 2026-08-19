import { Router } from "express";
import { PlanRequestSchema } from "@repo/shared";
import { runPlanner } from "../agents/planner";
import { BedrockError } from "../lib/errors";
import { MESSAGES } from "../lib/messages";

export const planRouter = Router();

planRouter.post("/", async (req, res) => {
  const parsed = PlanRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: MESSAGES.INVALID_PLAN_BODY, errors: parsed.error.flatten() });
    return;
  }
  try {
    const result = await runPlanner(parsed.data);
    res.json(result);
  } catch (error) {
    // 502, not 500: the request was valid and the server is healthy — the
    // upstream model failed or returned something unusable.
    //
    // The error message stays in the log. It can carry AWS internals and prompt
    // fragments, so the client gets a fixed string instead.
    console.error(
      error instanceof BedrockError
        ? `[plan] ${error.message} (models tried: ${error.modelsTried.join(", ") || "n/a"})`
        : error
    );
    res.status(502).json({ message: MESSAGES.PLAN_FAILED });
  }
});





