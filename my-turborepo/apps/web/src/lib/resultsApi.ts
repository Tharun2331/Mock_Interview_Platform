import {
  EvaluationResponseSchema,
  type EvaluationResponse,
} from "@repo/shared";
import { api } from "@/lib/api";
import { UnexpectedResponseError } from "@/lib/profileApi";

// Parsed against the same shared schema the server builds the response from, so
// a route that changes shape fails here with a parse error rather than three
// components later with an undefined.

const sessionsUrl = (sessionId: string): string =>
  `/api/v1/sessions/${encodeURIComponent(sessionId)}/evaluation`;

export async function fetchEvaluation(
  sessionId: string
): Promise<EvaluationResponse> {
  const response = await api.get(sessionsUrl(sessionId));

  const parsed = EvaluationResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();

  return parsed.data;
}

// Whether another poll is worth making.
//
// Keyed on `averages` rather than on `completed === total`. The counts are a
// progress indicator and can briefly agree while the rollup is still being
// written, but `averages` is set by the same conditional update that completes
// the session — so it is the one signal that cannot say "done" early.
export function isEvaluationFinished(result: EvaluationResponse): boolean {
  return result.averages !== undefined || result.status === "failed";
}
