import { describe, expect, it } from "bun:test";
import {
  CachedPlanSchema,
  isCachedPlanFresh,
  isProfileComplete,
  normalizeTargetRole,
  ProfileGithubBody,
  ProfileDetailsBody,
  toProfileView,
  UserProfileSchema,
  type CachedPlan,
  type UserProfile,
} from "../../src/schemas/profile";
import { ITEM_TYPE } from "../../src/schemas/session";

const NOW = "2026-09-09T12:00:00.000Z";

// A complete profile, as the onboarding flow leaves it. Individual tests strip
// fields rather than build up, so the "incomplete" cases each isolate one
// missing piece.
function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    type: ITEM_TYPE.USER_PROFILE,
    userId: "user-1",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
    username: "tharun",
    firstName: "Tharun",
    lastName: "Sekar",
    githubUsername: "Tharun2331",
    resumeKey: "resumes/user-1/resume.pdf",
    resumeText: "redacted resume text",
    repos: [],
    profileVersion: 3,
    ...overrides,
  };
}

// This boolean is the onboarding redirect. Getting it wrong either traps a
// finished candidate on the profile page or lets an unfinished one reach an
// interview with nothing to plan from.
describe("isProfileComplete", () => {
  it("is true for a fully populated active profile", () => {
    expect(isProfileComplete(profile())).toBe(true);
  });

  it("is false while the account is being erased, however complete it looks", () => {
    expect(isProfileComplete(profile({ status: "deleting" }))).toBe(false);
  });

  it.each([
    ["firstName", { firstName: undefined }],
    ["lastName", { lastName: undefined }],
    ["resumeKey", { resumeKey: undefined }],
    ["resumeText", { resumeText: undefined }],
  ] as const)("is false without %s", (_label, missing) => {
    expect(isProfileComplete(profile(missing))).toBe(false);
  });

  // Explicitly not required: a candidate with no public repositories should
  // still be able to interview.
  it("is true without a GitHub username", () => {
    expect(isProfileComplete(profile({ githubUsername: undefined }))).toBe(true);
  });

  // A username is a display field; the gate does not depend on it.
  it("is true without a display username", () => {
    expect(isProfileComplete(profile({ username: undefined }))).toBe(true);
  });
});

// The view is what a client is allowed to see. The absences are the point.
describe("toProfileView", () => {
  it("never exposes resume text or the S3 key", () => {
    const view = toProfileView(profile());

    expect(view).not.toHaveProperty("resumeText");
    expect(view).not.toHaveProperty("resumeKey");
    expect(view).not.toHaveProperty("repos");
    expect(view).not.toHaveProperty("status");
  });

  it("reports resume presence as a boolean and repos as a count", () => {
    const withRepos = toProfileView(
      profile({
        repos: [
          { description: null, name: "a", fullName: "u/a", starCount: 1 },
          { description: "b", name: "b", fullName: "u/b", starCount: 2 },
        ],
      })
    );

    expect(withRepos.hasResume).toBe(true);
    expect(withRepos.repoCount).toBe(2);

    const withoutResume = toProfileView(profile({ resumeKey: undefined }));
    expect(withoutResume.hasResume).toBe(false);
  });

  // The redirect turns on this one boolean precisely so the browser does not
  // re-derive it. This assertion is what keeps the two from disagreeing.
  it("carries the server's own completeness verdict", () => {
    expect(toProfileView(profile()).complete).toBe(true);
    expect(toProfileView(profile({ resumeKey: undefined })).complete).toBe(false);
    expect(toProfileView(profile({ status: "deleting" })).complete).toBe(false);
  });
});

describe("normalizeTargetRole", () => {
  it("folds case, trims, and collapses interior whitespace", () => {
    expect(normalizeTargetRole("  Backend   Engineer ")).toBe("backend engineer");
    expect(normalizeTargetRole("BACKEND ENGINEER")).toBe("backend engineer");
    expect(normalizeTargetRole("Backend\tEngineer")).toBe("backend engineer");
    expect(normalizeTargetRole("Backend\nEngineer")).toBe("backend engineer");
  });

  it("treats the variations a candidate would type as one role", () => {
    const forms = [
      "Backend Engineer",
      "backend engineer",
      "Backend  Engineer",
      " backend Engineer ",
    ].map(normalizeTargetRole);

    expect(new Set(forms).size).toBe(1);
  });
});

// Freshness is the entire plan-cache invalidation mechanism, and a wrong
// "fresh" serves a plan built from material the candidate has since replaced.
describe("isCachedPlanFresh", () => {
  function cached(overrides: Partial<CachedPlan> = {}): CachedPlan {
    return {
      type: ITEM_TYPE.CACHED_PLAN,
      plan: {
        focusAreas: [
          { area: "Kafka", evidence: "order-service", source: "github" },
          { area: "Postgres", evidence: "order-service", source: "github" },
        ],
        questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
        startingDifficulty: "mid",
        targetMinutes: 30,
        reasoning: "why",
      },
      targetRole: "Backend Engineer",
      profileVersion: 3,
      generatedAt: NOW,
      ...overrides,
    };
  }

  it("is fresh when version and normalised role both match", () => {
    expect(
      isCachedPlanFresh({
        cached: cached(),
        profileVersion: 3,
        targetRole: "Backend Engineer",
      })
    ).toBe(true);
  });

  it("compares the role normalised, not literally", () => {
    expect(
      isCachedPlanFresh({
        cached: cached(),
        profileVersion: 3,
        targetRole: "  backend   ENGINEER ",
      })
    ).toBe(true);
  });

  it("is stale when the profile version has moved on", () => {
    expect(
      isCachedPlanFresh({
        cached: cached(),
        profileVersion: 4,
        targetRole: "Backend Engineer",
      })
    ).toBe(false);
  });

  // An older version is still a mismatch — freshness is equality, not recency.
  it("is stale when the supplied version is older than the cached one", () => {
    expect(
      isCachedPlanFresh({
        cached: cached(),
        profileVersion: 2,
        targetRole: "Backend Engineer",
      })
    ).toBe(false);
  });

  it("is stale for a genuinely different role", () => {
    expect(
      isCachedPlanFresh({
        cached: cached(),
        profileVersion: 3,
        targetRole: "Frontend Engineer",
      })
    ).toBe(false);
  });
});

describe("UserProfileSchema", () => {
  // Rows written before `type` existed must still parse — validate-on-read
  // turns a rejection here into a hard failure on a real account.
  it("defaults `type` so pre-existing rows still parse", () => {
    const { type: _dropped, ...withoutType } = profile();
    const parsed = UserProfileSchema.safeParse(withoutType);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe(ITEM_TYPE.USER_PROFILE);
    }
  });

  it("defaults repos to an empty array", () => {
    const { repos: _dropped, ...withoutRepos } = profile();
    const parsed = UserProfileSchema.safeParse(withoutRepos);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.repos).toEqual([]);
    }
  });

  it("rejects a negative or fractional profile version", () => {
    expect(UserProfileSchema.safeParse(profile({ profileVersion: -1 })).success).toBe(
      false
    );
    expect(UserProfileSchema.safeParse(profile({ profileVersion: 1.5 })).success).toBe(
      false
    );
  });

  it("rejects a status outside the enum", () => {
    const parsed = UserProfileSchema.safeParse({ ...profile(), status: "suspended" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(
      UserProfileSchema.safeParse(profile({ updatedAt: "09/09/2026" })).success
    ).toBe(false);
  });
});

describe("ProfileDetailsBody", () => {
  it("trims the display fields it accepts", () => {
    const parsed = ProfileDetailsBody.safeParse({
      username: "  tharun  ",
      firstName: "  Tharun ",
      lastName: " Sekar ",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        username: "tharun",
        firstName: "Tharun",
        lastName: "Sekar",
      });
    }
  });

  it("rejects a field that is only whitespace", () => {
    expect(
      ProfileDetailsBody.safeParse({
        username: "   ",
        firstName: "Tharun",
        lastName: "Sekar",
      }).success
    ).toBe(false);
  });

  // profileVersion is the server's to set; accepting it here would let a client
  // claim its material was current without having sent any.
  it("strips a client-supplied profileVersion", () => {
    const parsed = ProfileDetailsBody.safeParse({
      username: "tharun",
      firstName: "Tharun",
      lastName: "Sekar",
      profileVersion: 99,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).not.toHaveProperty("profileVersion");
    }
  });
});

// A cleared input box arrives as "" rather than absent. Folding it to undefined
// is what makes "I cleared this" mean "disconnect" instead of a validation error.
describe("ProfileGithubBody", () => {
  it("folds an empty or whitespace-only field to undefined", () => {
    for (const blank of ["", "   ", "\t"]) {
      const parsed = ProfileGithubBody.safeParse({ gitHub: blank });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.gitHub).toBeUndefined();
      }
    }
  });

  it("passes a real URL through untouched", () => {
    const parsed = ProfileGithubBody.safeParse({
      gitHub: "https://github.com/Tharun2331",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.gitHub).toBe("https://github.com/Tharun2331");
    }
  });

  it("rejects an over-long value", () => {
    expect(ProfileGithubBody.safeParse({ gitHub: "a".repeat(201) }).success).toBe(
      false
    );
  });
});

describe("CachedPlanSchema", () => {
  it("defaults `type` for rows written before the attribute existed", () => {
    const parsed = CachedPlanSchema.safeParse({
      plan: {
        focusAreas: [
          { area: "Kafka", evidence: "order-service", source: "github" },
          { area: "Postgres", evidence: "order-service", source: "github" },
        ],
        questionMix: { behavioural: 3, technical: 5, roleSpecific: 2 },
        startingDifficulty: "mid",
        targetMinutes: 30,
        reasoning: "why",
      },
      targetRole: "Backend Engineer",
      profileVersion: 3,
      generatedAt: NOW,
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.type).toBe(ITEM_TYPE.CACHED_PLAN);
    }
  });
});
