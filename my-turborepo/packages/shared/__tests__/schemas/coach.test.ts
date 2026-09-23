import { describe, expect, it } from "bun:test";
import {
  CachedCoachSchema,
  COACH_CACHE_VERSION,
  coachCacheStamp,
  isCachedCoachFresh,
  type CachedCoach,
  type CoachCacheStamp,
} from "../../src/schemas/coach";

// The stamp is the whole invalidation mechanism. Every test here is a scenario
// that must or must not invalidate a cached report, phrased as the change that
// happens in production rather than as a field comparison.

const row = (completedAt: string, summarised = false) => ({
  completedAt,
  ...(summarised ? { summary: "a narrative" } : {}),
});

function cached(stamp: CoachCacheStamp): CachedCoach {
  return CachedCoachSchema.parse({
    stamp,
    prose: { topics: [] },
    generatedAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("coachCacheStamp", () => {
  it("counts rows, the latest date and how many carry a narrative", () => {
    expect(
      coachCacheStamp([
        row("2026-01-01T00:00:00.000Z", true),
        row("2026-01-05T00:00:00.000Z"),
      ]),
    ).toEqual({
      rowCount: 2,
      latestCompletedAt: "2026-01-05T00:00:00.000Z",
      summarisedCount: 1,
      version: COACH_CACHE_VERSION,
    });
  });

  it("does not depend on the order it is given", () => {
    const rows = [
      row("2026-01-01T00:00:00.000Z"),
      row("2026-03-01T00:00:00.000Z"),
    ];

    expect(coachCacheStamp(rows)).toEqual(coachCacheStamp([...rows].reverse()));
  });

  it("stamps an empty history rather than refusing to", () => {
    // A candidate with no finished interviews still gets a cache check. It
    // always misses on the first call and hits after, which costs nothing
    // because the agent does not call Bedrock for an empty report either.
    expect(coachCacheStamp([])).toEqual({
      rowCount: 0,
      latestCompletedAt: "",
      summarisedCount: 0,
      version: COACH_CACHE_VERSION,
    });
  });
});

describe("isCachedCoachFresh", () => {
  const base = coachCacheStamp([
    row("2026-01-01T00:00:00.000Z", true),
    row("2026-02-01T00:00:00.000Z", true),
  ]);

  it("holds when nothing about the history has changed", () => {
    expect(isCachedCoachFresh({ cached: cached(base), stamp: base })).toBe(
      true,
    );
  });

  it("invalidates when an interview finishes", () => {
    const after = coachCacheStamp([
      row("2026-01-01T00:00:00.000Z", true),
      row("2026-02-01T00:00:00.000Z", true),
      row("2026-03-01T00:00:00.000Z", true),
    ]);

    expect(isCachedCoachFresh({ cached: cached(base), stamp: after })).toBe(
      false,
    );
  });

  it("invalidates when a narrative is attached to a row already counted", () => {
    // The race the stamp exists for. The history row lands at completion and
    // the summarizer attaches its narrative moments later, so a report
    // generated in that window was built without it — while rowCount and
    // latestCompletedAt are both unchanged and would call it fresh.
    const attached = coachCacheStamp([
      row("2026-01-01T00:00:00.000Z", true),
      row("2026-02-01T00:00:00.000Z", true),
      row("2026-03-01T00:00:00.000Z"),
    ]);
    const summarised = coachCacheStamp([
      row("2026-01-01T00:00:00.000Z", true),
      row("2026-02-01T00:00:00.000Z", true),
      row("2026-03-01T00:00:00.000Z", true),
    ]);

    expect(attached.rowCount).toBe(summarised.rowCount);
    expect(attached.latestCompletedAt).toBe(summarised.latestCompletedAt);
    expect(
      isCachedCoachFresh({ cached: cached(attached), stamp: summarised }),
    ).toBe(false);
  });

  it("invalidates when one row expires and another lands in the same window", () => {
    // rowCount alone cannot see this: TTL removed the oldest row and a new
    // interview added one, so the count is identical and the report is not.
    const rotated = coachCacheStamp([
      row("2026-02-01T00:00:00.000Z", true),
      row("2026-03-01T00:00:00.000Z", true),
    ]);

    expect(rotated.rowCount).toBe(base.rowCount);
    expect(isCachedCoachFresh({ cached: cached(base), stamp: rotated })).toBe(
      false,
    );
  });

  it("invalidates when a deploy bumps the version", () => {
    // The trigger with no signal in the data at all. Without it, improving the
    // prompt leaves every existing candidate on the old prompt's output until
    // they happen to finish another interview.
    // The item was written before the deploy; the request that reads it
    // computes the bumped version. Modelled that way round rather than with a
    // decremented stored version, because version 1 is the floor — there has
    // never been a version 0 and the schema will not represent one.
    const afterDeploy = { ...base, version: base.version + 1 };

    expect(
      isCachedCoachFresh({ cached: cached(base), stamp: afterDeploy }),
    ).toBe(false);
  });
});

describe("CachedCoachSchema", () => {
  it("defaults the type discriminator for items written before it existed", () => {
    expect(
      CachedCoachSchema.parse({
        stamp: coachCacheStamp([]),
        prose: { topics: [] },
        generatedAt: "2026-01-01T00:00:00.000Z",
      }).type,
    ).toBe("cached_coach");
  });

  it("rejects a stored item whose prose is not the shape the agent reads", () => {
    expect(() =>
      CachedCoachSchema.parse({
        stamp: coachCacheStamp([]),
        prose: { topics: [{ topic: "Backend" }] },
        generatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
