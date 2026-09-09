import { Router } from "express";
import {
  PlanRequestSchema,
  isCachedPlanFresh,
  type CachedPlan,
  type PlanResponse,
} from "@repo/shared";
import { runPlanner } from "../agents/planner";
import { getCachedPlan, putCachedPlan } from "../lib/profile";
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
    const { profileVersion, ...inputs } = await loadPlannerInputs({
      sessionId: parsed.data.sessionId,
      userId,
    });

    // Staleness is checked here rather than when a profile is saved, and that
    // is the whole point of the design: saving a profile stays a single cheap
    // write, and nothing pays for a Planner call until a plan is actually about
    // to be used. A candidate who edits their name four times has not bought
    // four generations.
    //
    // Compared against the SESSION's profileVersion, not the profile's current
    // one — see SessionMetaSchema. The Planner below reads this session's INPUTS
    // snapshot, so a cached plan is reusable exactly when it was built from that
    // same snapshot.
    let result: PlanResponse | undefined;

    if (profileVersion !== undefined) {
      // A broken cache must not fail a request the Planner can still serve. A
      // miss and an outage cost the same thing here — one generation — so this
      // degrades to a miss and logs, rather than propagating.
      let cached: CachedPlan | null = null;
      try {
        cached = await getCachedPlan({ userId });
      } catch (error) {
        console.warn(
          `[plan] cache read failed, planning fresh — ${
            error instanceof Error ? error.message : "unknown"
          }`
        );
      }

      if (
        cached !== null &&
        isCachedPlanFresh({
          cached,
          profileVersion,
          targetRole: parsed.data.targetRole,
        })
      ) {
        stage("cache hit");
        result = cached.plan;
      }
    }

    if (result === undefined) {
      stage("calling planner");

      result = await runPlanner({
        targetRole: parsed.data.targetRole,
        ...inputs,
      });

      // Cached after a successful generation, never before. Stamped with the
      // version read at the top of this handler rather than re-read now: a
      // profile saved while the model was running would otherwise mark this
      // plan as matching material it never saw.
      //
      // Failure here loses a cache entry, not the plan. The candidate has their
      // interview either way, so this must not turn a successful generation
      // into a failed request.
      if (profileVersion !== undefined) {
        try {
          await putCachedPlan({
            userId,
            plan: result,
            targetRole: parsed.data.targetRole,
            profileVersion,
          });
        } catch (error) {
          console.warn(
            `[plan] cache write failed — ${
              error instanceof Error ? error.message : "unknown"
            }`
          );
        }
      }
    }

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





