import { type PlanRequest, type PlanResponse } from "@repo/shared";

export async function runPlanner(req: PlanRequest): Promise<PlanResponse> {
  return {
    mode: "mock",
    recommendedPath: [
      "Scrape GitHub repos",
      "Parse resume",
      "Analyze target role",
      "Behavioral questions",
      "Technical questions",
      "Evaluate answers",
      "Coaching summary",
    ],
    reasoning: `Mock interview path selected for topic "${req.topic}". Goal: ${req.goal}.`,
  };
}
