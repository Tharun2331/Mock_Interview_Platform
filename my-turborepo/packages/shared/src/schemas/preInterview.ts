import z from "zod";

export const PreInterviewBody = z.object ({
  gitHub: z.string()
})

export type PreInterviewBody = z.infer<typeof PreInterviewBody>;
