import { describe, expect, it } from "bun:test";
import { PLAN_LIMITS } from "@repo/shared";
import { INTERVIEW } from "../../lib/constants";
import {
  effectiveTargetMinutes,
  nudgeSchedule,
  wrapUpAtRemainingMinutes,
  type ClockSettings,
} from "../../lib/interviewClock";

// The acceptance check for test mode is a set of timestamps, so it is asserted
// here rather than by watching the countdown: a clock on screen cannot tell a
// nudge that fired at the wrong second from one that never fired at all.

const PROD: ClockSettings = { testMode: false, testTargetMinutes: 6 };
const TEST: ClockSettings = { testMode: true, testTargetMinutes: 6 };

const SECONDS = (ms: number): number => ms / 1000;

describe("effectiveTargetMinutes", () => {
  it("uses the plan's own length in production", () => {
    expect(effectiveTargetMinutes(30, PROD)).toBe(30);
    expect(effectiveTargetMinutes(PLAN_LIMITS.MAX_TARGET_MINUTES, PROD)).toBe(40);
  });

  it("overrides the plan's length in test mode", () => {
    expect(effectiveTargetMinutes(30, TEST)).toBe(6);
  });

  // PLAN_LIMITS is untouched on purpose: it is what the Planner's prompt states,
  // what its output is validated against, and what every stored plan is
  // re-validated against on read. A six-minute plan reaching DynamoDB would
  // fail that read and the interview would refuse to start.
  it("does not require a plan outside the production band", () => {
    const planned = PLAN_LIMITS.MIN_TARGET_MINUTES;
    expect(planned).toBe(15);
    // The plan stays schema-valid; only the running session is shortened.
    expect(effectiveTargetMinutes(planned, TEST)).toBe(6);
  });
});

// The acceptance numbers, asserted exactly.
describe("the schedule at the 6-minute test scale", () => {
  const schedule = nudgeSchedule(6, TEST);

  it("fires the wrap-up nudge at 5m15s — 87.5% through", () => {
    expect(SECONDS(schedule.wrapUpAtMs)).toBe(315);
    expect(schedule.wrapUpAtMs / (6 * 60_000)).toBeCloseTo(0.875, 5);
  });

  it("fires the final call at 5m42s — 95% through", () => {
    expect(SECONDS(schedule.finalCallAtMs)).toBe(342);
    expect(schedule.finalCallAtMs / (6 * 60_000)).toBeCloseTo(0.95, 5);
  });

  // The grace is not scaled: it exists so the interviewer can finish a
  // sentence, and a sentence takes the same few seconds at any scale.
  it("hard stops at 7m00s — the target plus the unscaled grace", () => {
    expect(SECONDS(schedule.hardStopAtMs)).toBe(420);
    expect(schedule.hardStopAtMs - 6 * 60_000).toBe(INTERVIEW.HARD_STOP_GRACE_MS);
  });

  it("keeps the nudges in order and inside the session", () => {
    expect(schedule.wrapUpAtMs).toBeLessThan(schedule.finalCallAtMs);
    expect(schedule.finalCallAtMs).toBeLessThan(schedule.hardStopAtMs);
    expect(schedule.finalCallAtMs).toBeLessThan(6 * 60_000);
  });

  // Fixed offsets would put the wrap-up at 3:00 — half way through — and tell
  // the interviewer to start closing before it had asked anything. This is the
  // whole reason the offsets scale in test mode.
  it("does not reuse the fixed production offsets", () => {
    expect(schedule.wrapUpAtMs).not.toBe(6 * 60_000 - INTERVIEW.WRAP_UP_BEFORE_MS);
    expect(SECONDS(schedule.wrapUpAtMs)).toBeGreaterThan(180);
  });
});

// Production must be bit-identical to what it was before test mode existed.
describe("production timings are unchanged", () => {
  it.each([15, 20, 30, 40])("keeps the fixed offsets at %d minutes", (minutes) => {
    const schedule = nudgeSchedule(minutes, PROD);
    const targetMs = minutes * 60_000;

    expect(schedule.wrapUpAtMs).toBe(targetMs - INTERVIEW.WRAP_UP_BEFORE_MS);
    expect(schedule.finalCallAtMs).toBe(targetMs - INTERVIEW.FINAL_CALL_BEFORE_MS);
    expect(schedule.hardStopAtMs).toBe(targetMs + INTERVIEW.HARD_STOP_GRACE_MS);
  });

  // Converting production to percentages would have moved this one: 12.5% of
  // 15 minutes is 1.9, not 3. Pinned so a future tidy-up cannot quietly do it.
  it("still warns three minutes out at the 15-minute floor", () => {
    const schedule = nudgeSchedule(15, PROD);
    expect(SECONDS(15 * 60_000 - schedule.wrapUpAtMs)).toBe(180);
  });
});

describe("wrapUpAtRemainingMinutes", () => {
  // The prompt states this threshold and the server schedules the nudge. If
  // they name different moments, the interviewer is told to close at a time
  // nothing signals.
  it("matches the scheduled nudge in production", () => {
    const schedule = nudgeSchedule(30, PROD);
    const remainingAtNudgeMs = 30 * 60_000 - schedule.wrapUpAtMs;

    expect(wrapUpAtRemainingMinutes(30, PROD)).toBe(
      remainingAtNudgeMs / 60_000
    );
  });

  // 12.5% of six minutes is 45 seconds. "0 minutes or fewer remain" is an
  // instruction that can never be satisfied, so it floors at 1.
  it("floors at one minute rather than rounding a short session to zero", () => {
    expect(wrapUpAtRemainingMinutes(6, TEST)).toBe(1);
  });

  it("never reports zero for any plausible test length", () => {
    for (const minutes of [1, 2, 3, 5, 6, 8, 10]) {
      expect(wrapUpAtRemainingMinutes(minutes, TEST)).toBeGreaterThanOrEqual(1);
    }
  });
});

// A session shorter than the fixed offsets would schedule a timer in the past,
// which fires immediately — telling the interviewer to wrap up before it has
// spoken. Only reachable if someone runs test mode without the scaled offsets.
describe("degenerate lengths", () => {
  it("never schedules a nudge before the interview starts", () => {
    for (const minutes of [1, 2, 3]) {
      const prod = nudgeSchedule(minutes, PROD);
      expect(prod.wrapUpAtMs).toBeGreaterThanOrEqual(0);
      expect(prod.finalCallAtMs).toBeGreaterThanOrEqual(0);

      const test = nudgeSchedule(minutes, TEST);
      expect(test.wrapUpAtMs).toBeGreaterThan(0);
      expect(test.finalCallAtMs).toBeGreaterThan(test.wrapUpAtMs);
    }
  });

  // At two minutes the production offsets both collapse to zero, and the
  // scaled ones still describe a usable schedule. This is the comparison that
  // says the scaling is doing something.
  it("stays usable at two minutes where the fixed offsets collapse", () => {
    expect(nudgeSchedule(2, PROD).wrapUpAtMs).toBe(0);
    expect(SECONDS(nudgeSchedule(2, TEST).wrapUpAtMs)).toBe(105);
  });
});
