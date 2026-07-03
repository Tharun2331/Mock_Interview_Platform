import z from "zod";

export const PreInterviewBody = z.object ({
  gitHub: z.string()
})