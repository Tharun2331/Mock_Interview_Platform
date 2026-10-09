import {
  AdminAccessResponseSchema,
  AdminMetricsResponseSchema,
  AdminUsersResponseSchema,
  type AdminAccessResponse,
  type AdminMetricsResponse,
  type AdminUsersResponse,
  type MetricsWindowHours,
} from "@repo/shared";
import { api } from "@/lib/api";
import { fetchMe } from "@/lib/authApi";
import { UnexpectedResponseError } from "@/lib/profileApi";

// The admin surface's three calls, each parsed against the shared schema so a
// route that changes shape fails here rather than as an undefined inside a
// chart's geometry — the same contract every other API module in this app holds.

const ADMIN_USERS_URL = "/api/v1/admin/users";
const ADMIN_ACCESS_URL = "/api/v1/admin/unlimited-access";
const ADMIN_METRICS_URL = "/api/v1/admin/metrics";

// Whether this session's token carries the admin group.
//
// Read from GET /auth/me, which reports the ACCESS token's `cognito:groups`
// claim — the same claim the server's RequireAdmin checks — so the client and
// the server are reading one value rather than two that can disagree. The token
// itself is an httpOnly cookie this page cannot read (ADR-0011), so asking the
// server is the only way to learn it.
//
// **This is a rendering decision, never an authorisation one.** It exists so a
// non-admin is not shown a nav link to a page that would 404, and so the page can
// say "you are not an admin" instead of rendering a broken dashboard. Anyone can
// edit their own JavaScript, so nothing here is a control — the server's
// middleware is, and every one of the three calls below is refused without it.
//
// Group membership lands on the token at sign-in. A user added to the group
// mid-session keeps a token without the claim until it refreshes, so the honest
// answer for them is false until they sign in again — which is why the page says
// so rather than suggesting a retry.
export async function isAdminSession(): Promise<boolean> {
  try {
    const { groups } = await fetchMe();
    return groups.includes(ADMIN_GROUP);
  } catch {
    // A failed session read is not an admin session. Deliberately not
    // distinguished from "signed out": RequireAuth has already established that
    // there is a session, so a failure here is a transient token problem and
    // treating it as admin would render a dashboard whose every call 404s.
    return false;
  }
}

// Mirrors `adminGroupName` in apps/servers/lib/config.ts and
// `var.admin_group_name` in the cognito Terraform module. Three places hold this
// string; they are wired together by matching defaults rather than by a shared
// constant, because the browser cannot read the server's config and neither can
// read Terraform. A mismatch here hides the nav link from a real admin — visible
// and harmless — rather than granting anything, which is the right direction for
// the copy that is hardest to keep in sync.
const ADMIN_GROUP = "admins";

export async function fetchAdminUsers(
  cursor?: string,
): Promise<AdminUsersResponse> {
  const response = await api.get(ADMIN_USERS_URL, {
    // Omitted rather than sent empty on the first page. An empty `cursor` would
    // fail the server's `min(1)` and turn page one into a 400.
    params: cursor === undefined ? undefined : { cursor },
  });

  const parsed = AdminUsersResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();

  return parsed.data;
}

export async function setUnlimitedAccess(args: {
  // Exactly one of these. The server refuses both-or-neither rather than picking,
  // because an email can name two Cognito identities once a federated provider is
  // attached — see AdminAccessBody.
  email?: string;
  username?: string;
  unlimitedAccess: boolean;
  // Absent revokes any numeric grant back to the default quota, which is what the
  // server's REMOVE clause does. Not the same as 0 — zero is a real grant meaning
  // "may start no interviews".
  sessionLimit?: number;
}): Promise<AdminAccessResponse> {
  const response = await api.post(ADMIN_ACCESS_URL, args);

  const parsed = AdminAccessResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();

  return parsed.data;
}

export async function fetchAdminMetrics(
  hours: MetricsWindowHours,
): Promise<AdminMetricsResponse> {
  const response = await api.get(ADMIN_METRICS_URL, { params: { hours } });

  const parsed = AdminMetricsResponseSchema.safeParse(response.data);
  if (!parsed.success) throw new UnexpectedResponseError();

  return parsed.data;
}
