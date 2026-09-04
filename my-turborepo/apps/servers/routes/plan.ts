import { Router } from "express";
import { PlanRequestSchema } from "@repo/shared";
import { runPlanner } from "../agents/planner";
import {
  BedrockError,
  ServiceError,
  SessionAccessError,
  SessionStateError,
} from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import { attachPlan, loadPlannerInputs } from "../lib/sessions";

export const planRouter = Router();

planRouter.post("/", async (req, res) => {
  const parsed = PlanRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: MESSAGES.INVALID_PLAN_BODY, errors: parsed.error.flatten() });
    return;
  }

  // AuthMiddleware guarantees req.user; the guard narrows the optional type.
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return;
  }

  // Three awaits, each of which can be slow for a different reason: a DynamoDB
  // read, a Bedrock generation, a DynamoDB write. The candidate waits on a
  // progress bar for all three with no way to tell them apart, so the stage
  // boundaries are logged. Without this a stalled request is indistinguishable
  // from a slow one, on the server as well as on the client.
  const startedAt = Date.now();
  const stage = (name: string): void => {
    console.log(`[plan] ${parsed.data.sessionId} ${name} +${Date.now() - startedAt}ms`);
  };

  try {
    stage("loading inputs");

    // Read from the session, never from the request. The client is not trusted
    // with the Planner's inputs: accepting repos and resume text on the wire
    // meant a caller could plan against someone else's material, and the server
    // had no way to tell the difference.
    const inputs = await loadPlannerInputs({
      sessionId: parsed.data.sessionId,
      userId,
    });

    stage("calling planner");

    const result = await runPlanner({
      targetRole: parsed.data.targetRole,
      ...inputs,
    });

    stage("persisting plan");

    // Persisted after the model call, so a Bedrock failure leaves the session
    // at `planning` and the candidate can retry against the same session rather
    // than re-uploading. The ownership check lives in the update's condition
    // expression — a session id belonging to someone else fails there, not here.
    await attachPlan({
      sessionId: parsed.data.sessionId,
      userId,
      targetRole: parsed.data.targetRole,
      plan: result,
    });

    stage("done");
    res.json(result);
  } catch (error) {
    stage("failed");

    // Unknown session and someone else's session are the same response by
    // design — see SessionAccessError.
    if (error instanceof SessionAccessError) {
      res.status(404).json({ message: error.message });
      return;
    }

    // 409, not 404: the session exists and is theirs, it is just past the point
    // where a plan can change. Ownership is already proven, so saying so leaks
    // nothing.
    if (error instanceof SessionStateError) {
      res.status(409).json({ message: error.message });
      return;
    }

    // The plan itself succeeded and storing it did not, so this must not read
    // as a model failure — 500 for our problem, not 502 for an upstream one.
    // The generated plan is lost either way: it is cheaper to re-run the
    // Planner than to invent a way to hand back an unpersisted one.
    if (error instanceof ServiceError) {
      console.error(`[plan] ${error.message}`);
      res.status(500).json({ message: MESSAGES.SESSION_UNAVAILABLE });
      return;
    }

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





