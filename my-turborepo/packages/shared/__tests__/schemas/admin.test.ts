import { describe, expect, it } from "bun:test";
import {
  AdminAccessBody,
  AdminMetricsQuery,
  AdminUserRowSchema,
  INTERVIEW_QUOTA,
  METRICS_WINDOW,
  resolveSessionAllowance,
} from "../../src/schemas/admin";

// `resolveSessionAllowance` is the single point where three stored fields become
// a decision, and TWO consumers read it: the route that refuses an interview and
// the admin table that displays the quota. A disagreement between them shows a
// candidate "2 remaining" and then refuses them, which reads as the product being
// broken rather than as a limit. So these tests are about the function being the
// only implementation, not about arithmetic.
describe("resolveSessionAllowance", () => {
  it("gives an ungranted account the default quota", () => {
    expect(
      resolveSessionAllowance({
        unlimitedAccess: false,
        sessionLimit: undefined,
        sessionsConducted: 0,
      }),
    ).toEqual({
      unlimited: false,
      limit: INTERVIEW_QUOTA.DEFAULT_SESSIONS,
      used: 0,
      remaining: INTERVIEW_QUOTA.DEFAULT_SESSIONS,
      exhausted: false,
    });
  });

  it("treats an absent sessionLimit as the default, NOT as zero", () => {
    // The distinction the two-field shape exists to preserve. Collapsed into one
    // nullable number, "no grant" and "a grant of zero" become the same value and
    // every ungranted account is suspended.
    const allowance = resolveSessionAllowance({
      unlimitedAccess: false,
      sessionLimit: undefined,
      sessionsConducted: 0,
    });

    expect(allowance.exhausted).toBe(false);
    expect(allowance.limit).toBe(INTERVIEW_QUOTA.DEFAULT_SESSIONS);
  });

  it("honours a granted limit of zero as a real suspension", () => {
    const allowance = resolveSessionAllowance({
      unlimitedAccess: false,
      sessionLimit: 0,
      sessionsConducted: 0,
    });

    expect(allowance.limit).toBe(0);
    expect(allowance.exhausted).toBe(true);
  });

  it("is exhausted exactly at the limit, not past it", () => {
    // Off-by-one here is the difference between three interviews and four. The
    // boundary is asserted from both sides rather than trusted.
    const atTwo = resolveSessionAllowance({
      unlimitedAccess: false,
      sessionLimit: 3,
      sessionsConducted: 2,
    });
    const atThree = resolveSessionAllowance({
      unlimitedAccess: false,
      sessionLimit: 3,
      sessionsConducted: 3,
    });

    expect(atTwo.exhausted).toBe(false);
    expect(atTwo.remaining).toBe(1);
    expect(atThree.exhausted).toBe(true);
    expect(atThree.remaining).toBe(0);
  });

  it("clamps remaining at zero when a grant is lowered below what was used", () => {
    // A real sequence: someone started five interviews on an unlimited grant, the
    // grant is revised down to one. A negative `remaining` would render as "-4
    // left" in the admin table and could sign-flip anything downstream.
    const allowance = resolveSessionAllowance({
      unlimitedAccess: false,
      sessionLimit: 1,
      sessionsConducted: 5,
    });

    expect(allowance.remaining).toBe(0);
    expect(allowance.exhausted).toBe(true);
    // `used` is still the truth, not clamped — the operator needs to see that
    // five were taken.
    expect(allowance.used).toBe(5);
  });

  it("reports remaining as null for an unlimited account, never Infinity", () => {
    // Infinity survives neither JSON nor DynamoDB: it serialises to null and
    // re-reads as a parse failure. A type that cannot represent it is the fix.
    const allowance = resolveSessionAllowance({
      unlimitedAccess: true,
      sessionLimit: undefined,
      sessionsConducted: 900,
    });

    expect(allowance.remaining).toBeNull();
    expect(allowance.unlimited).toBe(true);
    expect(allowance.exhausted).toBe(false);
  });

  it("keeps the underlying limit visible while unlimited is in force", () => {
    // The admin table shows what the cap WOULD be if the grant were revoked.
    // Recomputing that in the UI would be a second implementation of this
    // function, which is the thing these tests exist to prevent.
    const allowance = resolveSessionAllowance({
      unlimitedAccess: true,
      sessionLimit: 25,
      sessionsConducted: 4,
    });

    expect(allowance.limit).toBe(25);
    expect(allowance.unlimited).toBe(true);
  });

  it("lets unlimited win over an exhausted numeric grant", () => {
    // Both fields set and in conflict. Unlimited is the more permissive reading
    // and the one an admin most recently intended by setting it, so a stale
    // `sessionLimit` left behind must not suspend the account.
    const allowance = resolveSessionAllowance({
      unlimitedAccess: true,
      sessionLimit: 1,
      sessionsConducted: 50,
    });

    expect(allowance.exhausted).toBe(false);
  });
});

describe("AdminAccessBody", () => {
  it("lowercases and trims the email before it reaches Cognito", () => {
    // Cognito's ListUsers filter is an exact string comparison, so an untrimmed
    // or mixed-case email is a different lookup for the same account. Normalising
    // in the schema means every caller gets it, including one added later.
    const parsed = AdminAccessBody.parse({
      email: "  Tharun@Example.COM ",
      unlimitedAccess: false,
    });

    expect(parsed.email).toBe("tharun@example.com");
  });

  it("rejects a malformed email", () => {
    expect(
      AdminAccessBody.safeParse({
        email: "not-an-email",
        unlimitedAccess: false,
      }).success,
    ).toBe(false);
  });

  it("rejects a quote in the email, which is what could break the filter", () => {
    // Belt-and-braces against ListUsers filter injection: its string literals are
    // double-quoted with no documented escape. `z.email()` is what actually
    // refuses this, and this test is what stops someone loosening it to a plain
    // string without noticing the consequence.
    expect(
      AdminAccessBody.safeParse({
        email: 'a" OR email ^= "',
        unlimitedAccess: false,
      }).success,
    ).toBe(false);
  });

  it("refuses a sessionLimit above the fat-finger ceiling", () => {
    expect(
      AdminAccessBody.safeParse({
        email: "a@b.com",
        unlimitedAccess: false,
        sessionLimit: INTERVIEW_QUOTA.MAX_GRANTABLE_SESSIONS + 1,
      }).success,
    ).toBe(false);
  });

  it("accepts a sessionLimit of zero", () => {
    // Zero is a legal grant — the only way to suspend an account without deleting
    // it — so a `.positive()` here would be a silent removal of that capability.
    expect(
      AdminAccessBody.safeParse({
        email: "a@b.com",
        unlimitedAccess: false,
        sessionLimit: 0,
      }).success,
    ).toBe(true);
  });

  it("omits sessionLimit rather than defaulting it when absent", () => {
    // Absence is meaningful: it is what makes the server REMOVE the attribute and
    // fall back to the default. A default here would make "reset to default"
    // impossible to express.
    const parsed = AdminAccessBody.parse({
      email: "a@b.com",
      unlimitedAccess: false,
    });

    expect(parsed.sessionLimit).toBeUndefined();
  });
});

describe("AdminMetricsQuery", () => {
  it("coerces the query string and accepts every offered window", () => {
    for (const hours of METRICS_WINDOW.HOURS) {
      const parsed = AdminMetricsQuery.parse({ hours: String(hours) });
      expect(parsed.hours).toBe(hours);
    }
  });

  it("rejects a window that is not on the menu", () => {
    // The closed set is a cost control, not a preference: GetMetricData bills per
    // datapoint returned, and every offered window has a period chosen to keep the
    // point count bounded. An arbitrary `hours` would have no period to pair with.
    expect(AdminMetricsQuery.safeParse({ hours: "8760" }).success).toBe(false);
    expect(AdminMetricsQuery.safeParse({ hours: "0" }).success).toBe(false);
  });

  it("has a period for every window it accepts", () => {
    // The invariant the literal union buys at the type level, asserted at runtime
    // too — because someone adding an hours value and forgetting its period is the
    // exact mistake the union is there to catch, and a test says so in the failure
    // message rather than only in a compiler error at the lookup site.
    for (const hours of METRICS_WINDOW.HOURS) {
      expect(METRICS_WINDOW.PERIOD_SECONDS[hours]).toBeGreaterThan(0);
    }
  });

  it("offers the default window", () => {
    expect(
      (METRICS_WINDOW.HOURS as readonly number[]).includes(
        METRICS_WINDOW.DEFAULT_HOURS,
      ),
    ).toBe(true);
  });
});

describe("AdminUserRowSchema", () => {
  const row = {
    userId: "sub-1",
    email: "a@b.com",
    username: "a@b.com",
    enabled: true,
    status: "CONFIRMED",
    createdAt: "2026-09-01T00:00:00.000Z",
    profile: null,
  };

  it("accepts a directory entry with no profile", () => {
    // Signed up and never onboarded, which is a real and common state rather than
    // an error — and the one an operator most often wants to see in this table.
    expect(AdminUserRowSchema.safeParse(row).success).toBe(true);
  });

  it("defaults the quota fields on a profile written before the quota existed", () => {
    const parsed = AdminUserRowSchema.parse({
      ...row,
      profile: { complete: true },
    });

    // Every pre-quota account projects three absent attributes. Required fields
    // here would fail all of them out of the table, which is how a migration
    // breaks a page nobody changed.
    expect(parsed.profile?.sessionsConducted).toBe(0);
    expect(parsed.profile?.sessionsCreated).toBe(0);
    expect(parsed.profile?.unlimitedAccess).toBe(false);
    expect(parsed.profile?.sessionLimit).toBeUndefined();
  });

  it("accepts a Cognito status it has never seen", () => {
    // AWS's vocabulary, not ours. An enum here would fail a row this table only
    // displays, the first time Cognito added a lifecycle state.
    expect(
      AdminUserRowSchema.safeParse({ ...row, status: "SOMETHING_NEW" }).success,
    ).toBe(true);
  });
});
