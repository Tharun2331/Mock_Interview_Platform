import { CoachReportSchema, type CoachReport } from "@repo/shared";
import { api } from "@/lib/api";
import { UnexpectedResponseError } from "@/lib/profileApi";

// One call feeds the whole page — the trend cards and the roadmap both read the
// same report. Parsed against the shared schema, so a route that changes shape
// fails here rather than as an undefined inside a chart's geometry.

const COACH_URL = "/api/v1/coach";

export async function fetchCoachReport(): Promise<CoachReport> {
  const response = await api.get(COACH_URL);

  const parsed = CoachReportSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();

  return parsed.data;
}
