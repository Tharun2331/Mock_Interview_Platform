import {
  SessionHistoryResponseSchema,
  type SessionHistoryItem,
} from "@repo/shared";
import { api } from "@/lib/api";
import { UnexpectedResponseError } from "@/lib/profileApi";

// One call feeds the whole page — the trend chart and the card list both read
// the same array. Parsed against the shared schema, so a route that changes
// shape fails here rather than as an undefined inside the chart's geometry.

const HISTORY_URL = "/api/v1/sessions/history";

export async function fetchSessionHistory(): Promise<SessionHistoryItem[]> {
  const response = await api.get(HISTORY_URL);

  const parsed = SessionHistoryResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();

  return parsed.data.sessions;
}
