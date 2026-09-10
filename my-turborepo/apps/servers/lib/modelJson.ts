import { BedrockError } from "./errors";

// Lifted out of agents/planner.ts when the Evaluator needed the same thing.
// Both agents ask a model for a single JSON object and both receive prose or
// markdown fences around it regardless, so the recovery belongs in one place —
// the same reasoning that pulled lib/github.ts out of two routes.

// Models wrap JSON in prose or fences despite being told not to, and that is
// not worth a retry: a retry costs another generation to fix something already
// present in the reply. Take the outermost {...} instead of trusting the whole
// response.
//
// Outermost rather than first-balanced on purpose — `lastIndexOf` means a
// nested object cannot truncate the result, and a trailing "Let me know if you
// need changes." is discarded rather than breaking the parse.
export function extractJsonObject(raw: string, label: string): unknown {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    throw new BedrockError(`${label} reply contained no JSON object`);
  }

  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new BedrockError(`${label} reply was not valid JSON`);
  }
}
