import z from "zod";
import { resolveSessionAllowance } from "./admin";
import { PLAN_LIMITS, PlanResponseSchema } from "./plan";
import { PreInterviewRepo } from "./preInterview";
import { ITEM_TYPE } from "./session";

// User-scoped item shapes for the single DynamoDB table. Sessions used to own
// the candidate's material — a resume was uploaded per interview and parsed
// again every time. It is the same resume, so it now lives once under
// USER#<uid> and every session reads it from there.
//
// Validated in both directions, for the reason session.ts gives: an item
// written by an older deploy failing loudly at the storage boundary beats an
// `undefined` surfacing three layers up.

export const PROFILE_LIMITS = {
  MAX_USERNAME: 64,
  MAX_NAME: 80,
} as const;

// `deleting` is set the moment an erasure request arrives and is never cleared:
// the sweep that follows removes the item entirely. It exists so every route
// can refuse an account whose data is on its way out, even if the sweep has not
// reached that particular item yet — and so a crashed sweep leaves a marker
// behind rather than a half-deleted account that looks healthy.
export const ProfileStatusSchema = z.enum(["active", "deleting"]);

export type ProfileStatus = z.infer<typeof ProfileStatusSchema>;

// USER#<uid> / PROFILE
//
// Every display field is optional even though the onboarding form collects them
// together. The item is built by upserts — a name save and a resume upload are
// separate requests that can each fail — so a partially filled profile is a real
// state rather than a corrupt one. `isProfileComplete` is the gate, not the
// schema, for the same reason SessionMetaSchema.plan is optional: requiring a
// field the writer cannot always supply forces a placeholder that reads as real.
export const UserProfileSchema = z.object({
  type: z.literal(ITEM_TYPE.USER_PROFILE).default(ITEM_TYPE.USER_PROFILE),
  // No `expiresAt`. Session items carry a TTL; this one is the account itself,
  // and an account that evaporates after a quiet few months is a bug rather
  // than a retention policy. It goes only when erasure removes it.
  userId: z.string().min(1),
  status: ProfileStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),

  username: z.string().min(1).max(PROFILE_LIMITS.MAX_USERNAME).optional(),
  firstName: z.string().min(1).max(PROFILE_LIMITS.MAX_NAME).optional(),
  lastName: z.string().min(1).max(PROFILE_LIMITS.MAX_NAME).optional(),
  githubUsername: z.string().min(1).optional(),

  // The S3 archive pointer, `resumes/<uid>/resume.pdf`. One object per user,
  // overwritten on re-upload — it is the original PDF, PII and all, kept so a
  // parser change can be re-run without asking the candidate to re-submit.
  resumeKey: z.string().min(1).optional(),
  // The redacted text, and the only resume content the Planner ever sees. It
  // lives here rather than in S3 so that it and `profileVersion` are written in
  // one atomic update: split across two stores, a failure between them leaves a
  // new resume behind a stale version marker, the plan cache silently fails to
  // invalidate, and the Planner reasons over material that no longer exists.
  resumeText: z.string().max(PLAN_LIMITS.MAX_RESUME_CHARS).optional(),
  repos: z.array(PreInterviewRepo).max(PLAN_LIMITS.MAX_REPOS).default([]),

  // Bumped only when Planner-relevant material changes — resume text or repos.
  // Editing a display name does not touch it, because a name has no bearing on
  // the plan and invalidating the cache over one would buy a Bedrock call for
  // nothing. This is the sole staleness signal: a cached plan is reusable if and
  // only if the version it was generated from still matches.
  profileVersion: z.number().int().min(0),

  // ---- Interview quota -----------------------------------------------------
  //
  // See `INTERVIEW_QUOTA` and `resolveSessionAllowance` in admin.ts, which owns
  // what these three mean together. They live on the PROFILE item rather than in
  // a separate QUOTA item so the enforcement check is part of the profile read
  // that `POST /pre-interview` already performs — a second item would add a
  // round trip to the interview start path to hold two numbers.

  // Interviews this account has actually CONDUCTED — the number the quota meters.
  //
  // CLAIMED atomically when the interview WebSocket opens the Sonic stream —
  // `claimInterviewSlot` in apps/servers/lib/profile.ts, a compare-and-swap on
  // this counter. Not when the session is minted (that burned a slot for a
  // closed tab), and not on the first scoreable answer (that was checked only at
  // mint time, so a candidate could mint any number of sessions at 0 used and
  // conduct all of them, and an interview of nothing but "could you repeat that"
  // was never charged at all).
  //
  // The fairness the scoreable-answer rule bought is kept by a REFUND instead: a
  // session that ends inside INTERVIEW.QUOTA_REFUND_WINDOW_MS with no scoreable
  // answer gives its slot back. The window is what stops the refund being a free
  // interview.
  //
  // Deliberately not derived from the `USER#<uid>/SESSION#<sid>` rows. Those carry
  // `expiresAt` and are removed by TTL after SESSION_RETENTION.DAYS, so a quota
  // counted from them would silently reset itself six months in — the account
  // would be back to three free sessions with nothing in the logs saying why. A
  // counter that only ever goes up cannot do that.
  //
  // **Replaces `sessionsStarted`**, which counted mints. That attribute is no
  // longer read; rows still carrying it parse fine because Zod strips unknown
  // keys, and the practical effect is that accounts metered under the old rule
  // start again from zero. That is the correct direction — those counts were
  // taken by a rule that charged for sessions nobody conducted.
  sessionsConducted: z.number().int().min(0).default(0),

  // Sessions MINTED, including ones never conducted. Display only — nothing gates
  // on it.
  //
  // Kept because the gap between this and `sessionsConducted` is itself the
  // signal: an account with 12 created and 1 conducted is someone repeatedly
  // bouncing off the interview screen, which is worth seeing whether it is
  // confusion, a broken microphone, or abuse. Collapsing the two into one number
  // is what hid the original bug.
  sessionsCreated: z.number().int().min(0).default(0),

  // Admin grant. Absent/false is the ungranted state, NOT a zero limit — the
  // three-state reasoning is in AccessGrantSchema. Both default rather than being
  // required, for the same backfill reason as `sessionsStarted`: an account that
  // predates the quota has no grant and must read as ungranted rather than fail.
  unlimitedAccess: z.boolean().default(false),
  sessionLimit: z.number().int().min(0).optional(),
});

export type UserProfile = z.infer<typeof UserProfileSchema>;

// The onboarding redirect condition. Deliberately derived rather than stored: a
// `profileComplete` boolean would be a second source of truth for something
// already answerable from the item, and the two drift the first time a write
// sets one without the other.
//
// GitHub is not required. A plan built from a resume alone is worse but valid,
// and a candidate with no public repositories should not be blocked.
export function isProfileComplete(profile: UserProfile): boolean {
  return (
    profile.status === "active" &&
    profile.firstName !== undefined &&
    profile.lastName !== undefined &&
    profile.resumeKey !== undefined &&
    profile.resumeText !== undefined
  );
}

// The slice of a PROFILE item the admin user table needs, and the projection that
// fetches it.
//
// A projection rather than the whole item because `resumeText` is up to
// PLAN_LIMITS.MAX_RESUME_CHARS and the admin table has no use for a single
// character of it: at a 60-row page that is over a megabyte of redacted resume
// crossing the wire to render a quota column. Every name is listed here so the
// schema and the projection cannot drift — a field added to one and not the other
// fails validation rather than silently reading as absent.
//
// `complete` is NOT derived by calling `isProfileComplete` on this, because this
// shape deliberately lacks `resumeText` and that function requires it. The admin
// table asks a coarser question — has this account onboarded — and `resumeKey`
// answers it: `saveResumeAndRepos` writes the key and the text in one atomic
// UpdateItem, so one cannot exist without the other. Worth knowing if that write
// is ever split: this would start reading as complete a fraction earlier.
export const ADMIN_PROFILE_FIELDS = [
  "userId",
  "status",
  "firstName",
  "lastName",
  "resumeKey",
  "sessionsConducted",
  "sessionsCreated",
  "unlimitedAccess",
  "sessionLimit",
] as const;

export const AdminProfileProjectionSchema = z.object({
  userId: z.string().min(1),
  status: ProfileStatusSchema,
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  resumeKey: z.string().min(1).optional(),
  // Defaulted for the same backfill reason the stored item defaults them: an
  // account that predates the quota projects these as absent, and a required
  // field here would fail every such row out of the admin table.
  sessionsConducted: z.number().int().min(0).default(0),
  sessionsCreated: z.number().int().min(0).default(0),
  unlimitedAccess: z.boolean().default(false),
  sessionLimit: z.number().int().min(0).optional(),
});

export type AdminProfileProjection = z.infer<
  typeof AdminProfileProjectionSchema
>;

// PUT /api/v1/profile — the editable display fields, and only those. A resume
// arrives as multipart on its own route, and `profileVersion` is the server's to
// set: accepting either here would let a client claim its material was current
// without having sent any.
export const ProfileDetailsBody = z.object({
  username: z.string().trim().min(1).max(PROFILE_LIMITS.MAX_USERNAME),
  firstName: z.string().trim().min(1).max(PROFILE_LIMITS.MAX_NAME),
  lastName: z.string().trim().min(1).max(PROFILE_LIMITS.MAX_NAME),
});

export type ProfileDetailsBody = z.infer<typeof ProfileDetailsBody>;

// PUT /api/v1/profile/github. Reuses the same preprocessing as the upload form:
// a blank field arrives as "" rather than absent, and folding it to undefined is
// what lets "I cleared this box" mean "disconnect" instead of failing the URL
// check on an empty string.
export const ProfileGithubBody = z.object({
  gitHub: z.preprocess(
    (value) =>
      typeof value === "string" && value.trim().length === 0
        ? undefined
        : value,
    z.string().max(200).optional(),
  ),
});

export type ProfileGithubBody = z.infer<typeof ProfileGithubBody>;

// What a client is allowed to see. Deliberately not the stored item.
//
// `resumeText` is absent even though it is redacted: the browser has no use for
// it, it is the largest field on the item, and the smallest surface that answers
// "is this profile complete and how current is it" is the one worth shipping.
// `resumeKey` is absent too — an S3 key is server-side addressing, and a client
// that never sees one cannot be the source of a request to read someone else's.
export const ProfileViewSchema = z.object({
  userId: z.string().min(1),
  username: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  githubUsername: z.string().optional(),
  hasResume: z.boolean(),
  repoCount: z.number().int().min(0),
  profileVersion: z.number().int().min(0),
  // Computed server-side by `isProfileComplete` rather than re-derived in the
  // browser. The onboarding redirect turns on this one boolean, and two
  // implementations of it would eventually disagree about who gets sent where.
  complete: z.boolean(),
  updatedAt: z.iso.datetime(),

  // The candidate's own interview quota, resolved server-side.
  //
  // Included because enforcement without visibility is a trap: a candidate who
  // cannot see a count gets a 409 at the moment they try to start their fourth
  // interview, which reads as the product breaking rather than as a limit. This
  // is their own allowance and nobody else's, so it carries no more information
  // than the sessions they already know they have held.
  //
  // Resolved here rather than sent as the three raw fields, so the browser never
  // reimplements `resolveSessionAllowance` — the defect that would produce is a
  // UI saying "1 remaining" over a server that refuses.
  sessions: z.object({
    unlimited: z.boolean(),
    limit: z.number().int().min(0),
    used: z.number().int().min(0),
    remaining: z.number().int().min(0).nullable(),
    exhausted: z.boolean(),
    // Sessions minted, conducted or not. Carried so a candidate whose count looks
    // wrong to them can be shown the difference rather than argued with.
    created: z.number().int().min(0),
  }),
});

export type ProfileView = z.infer<typeof ProfileViewSchema>;

export function toProfileView(profile: UserProfile): ProfileView {
  return {
    userId: profile.userId,
    username: profile.username,
    firstName: profile.firstName,
    lastName: profile.lastName,
    githubUsername: profile.githubUsername,
    hasResume: profile.resumeKey !== undefined,
    repoCount: profile.repos.length,
    profileVersion: profile.profileVersion,
    complete: isProfileComplete(profile),
    updatedAt: profile.updatedAt,
    sessions: {
      ...resolveSessionAllowance({
        unlimitedAccess: profile.unlimitedAccess,
        sessionLimit: profile.sessionLimit,
        sessionsConducted: profile.sessionsConducted,
      }),
      created: profile.sessionsCreated,
    },
  };
}

// GET /api/v1/profile. Null rather than a 404 for a candidate who has never
// saved one: "no profile yet" is the expected state on first sign-in and the
// answer the onboarding guard is asking for, not an error.
export const ProfileResponseSchema = z.object({
  profile: ProfileViewSchema.nullable(),
});

export type ProfileResponse = z.infer<typeof ProfileResponseSchema>;

// POST /api/v1/profile/resume.
//
// The redaction summary is reported back on purpose: a candidate handing over a
// resume deserves to see that personal details were stripped and how many. It
// carries counts and type names only — a summary that quoted the removed values
// would undo the removal.
export const ResumeUploadResponseSchema = z.object({
  profile: ProfileViewSchema,
  resume: z.object({
    characters: z.number().int().min(0),
    pages: z.number().int().min(0),
    usable: z.boolean(),
    redactedCount: z.number().int().min(0),
    redactedTypes: z.array(z.string()),
  }),
});

export type ResumeUploadResponse = z.infer<typeof ResumeUploadResponseSchema>;

// Roles are free text, so "Backend Engineer", "backend engineer" and
// "Backend  Engineer" are the same interview and must hit the same cache entry.
// Normalising at comparison time rather than storing a normalised copy keeps the
// role the candidate actually typed available for display.
export const normalizeTargetRole = (role: string): string =>
  role.trim().toLowerCase().replace(/\s+/g, " ");

// USER#<uid> / PLAN — the last plan generated for this candidate.
//
// One entry per user rather than one per role (`PLAN#<role>`). Roles are free
// text, so a per-role key grows without bound as someone types variations, and
// nothing would ever evict them. A single slot means alternating between two
// roles pays for a regeneration each time, which is the right trade against an
// unbounded partition for a cache whose miss cost is one Planner call.
export const CachedPlanSchema = z.object({
  type: z.literal(ITEM_TYPE.CACHED_PLAN).default(ITEM_TYPE.CACHED_PLAN),
  plan: PlanResponseSchema,
  // Stored as typed, compared normalised.
  targetRole: z.string().min(1).max(200),
  // The profile version this plan was generated from. Compared against the
  // profile's current version at interview start — that comparison is the whole
  // invalidation mechanism, which is why it is lazy: nothing has to be
  // recomputed when a profile is saved, only when a plan is about to be used.
  profileVersion: z.number().int().min(0),
  generatedAt: z.iso.datetime(),
});

export type CachedPlan = z.infer<typeof CachedPlanSchema>;

// Both conditions, in one place, so the route that reads the cache and any test
// that exercises it cannot disagree about what "fresh" means.
export function isCachedPlanFresh(args: {
  cached: CachedPlan;
  profileVersion: number;
  targetRole: string;
}): boolean {
  return (
    args.cached.profileVersion === args.profileVersion &&
    normalizeTargetRole(args.cached.targetRole) ===
      normalizeTargetRole(args.targetRole)
  );
}
