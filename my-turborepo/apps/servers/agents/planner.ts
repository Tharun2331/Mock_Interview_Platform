import { type PlanRequest,type PlanResponse } from "@repo/shared";
export async function runPlanner(req:PlanRequest): Promise<PlanResponse> {
    if (req.mode ==="mock") {
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

  return {
    mode: "concept",
    recommendedPath: [
      "Break topic into subtopics",
      "Map difficulty levels",
      "Generate quiz questions",
      "Create flashcards",
      "Build coding challenges",
      "Generate study plan",
      "Coaching summary",
    ],
    reasoning: `Concept mastery path selected for topic "${req.topic}". Goal: ${req.goal}.`,
  };
}
