import { Router } from "express";
import { PlanRequestSchema } from "@repo/shared";
import { runPlanner } from "../agents/planner";

export const planRouter = Router();

planRouter.post("/", async (req,res) => {
  const parsed = PlanRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: "Invalid request body", errors: parsed.error.flatten() });
    return;
  }
  const result = await runPlanner(parsed.data);
  res.json(result);
})





