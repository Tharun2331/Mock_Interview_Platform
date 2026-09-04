import z from "zod";
import { PLAN_LIMITS, PlanResponseSchema } from "./plan";
import { PreInterviewRepo } from "./preInterview";

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
