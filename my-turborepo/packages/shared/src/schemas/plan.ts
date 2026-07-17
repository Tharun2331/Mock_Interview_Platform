import z from "zod";

export const PlanRequestSchema = z.object({
  mode: z.enum(["mock"]),
  topic: z.string().min(1).max(200),
  goal: z.string().min(1).max(200),
})


export type PlanRequest = z.infer<typeof PlanRequestSchema>


export const PlanResponseSchema = z.object({
  mode: z.enum(["mock"]),
  recommendedPath: z.array(z.string()),
  reasoning: z.string(),
})


export type PlanResponse = z.infer<typeof PlanResponseSchema>

