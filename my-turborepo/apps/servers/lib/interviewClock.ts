import { config } from "./config";
import { INTERVIEW } from "./constants";

// How long an interview actually runs, and when its two nudges fire.
//
// Pure, and separate from routes/interview.ts so the schedule can be asserted
// directly. What is being verified is a set of timestamps — "the wrap-up fires
// at 5m15s of a 6-minute session" — and watching a clock on screen can neither
// measure that nor tell a nudge that fired late from one that never fired.

export type ClockSettings = {
  testMode: boolean;
  testTargetMinutes: number;
};

// Taken from config by default and injectable for tests.
//
// Injectable rather than mocked: `mock.module` is global for the whole test
// process, and lib/config is imported by nearly every module, so stubbing it
// would hand a fake config to every test file loaded afterwards. A parameter
// with a default costs one argument and cannot leak.
function currentSettings(): ClockSettings {
  return {
    testMode: config.interviewTestMode,
    testTargetMinutes: config.interviewTestTargetMinutes,
  };
}

export type NudgeSchedule = {
  // Milliseconds from the start of the interview.
  wrapUpAtMs: number;
  finalCallAtMs: number;
  hardStopAtMs: number;
};

// The plan's length, or the test override when test mode is on.
//
// The override lives here rather than in the Planner because a plan is
// validated on the way out of DynamoDB as well as on the way in. A stored plan
// carrying six minutes would fail PlanResponseSchema on read and the interview
// would refuse to start — so the plan keeps a schema-valid length and only the
// running session is shortened.
export function effectiveTargetMinutes(
  plannedMinutes: number,
  settings: ClockSettings = currentSettings()
): number {
  return settings.testMode ? settings.testTargetMinutes : plannedMinutes;
}

// Fractions of the interview, used ONLY in test mode.
//
// Production keeps its fixed offsets — three minutes to wrap up, one minute for
// the final call — because those are absolute amounts of conversation rather
// than proportions: a closing question and a warm sign-off take about as long
// in a 15-minute interview as in a 40-minute one. Converting production to
// percentages would move the 15-minute case from a 3-minute warning to a
// 1.9-minute one, which is a behaviour change nobody asked for.
//
// Those same fixed offsets are nonsense at six minutes, where three minutes is
// half the session and the interviewer would be told to start closing before it
// had asked anything. Scaling them preserves the *shape* of the schedule — a
// nudge near the end, a blunter one just before the close — which is the thing
// a short session is being run to exercise.
//
// Expressed as the fraction REMAINING, so 0.125 means "fires once 87.5% of the
// interview has gone".
const TEST_WRAP_UP_REMAINING_FRACTION = 0.125;
const TEST_FINAL_CALL_REMAINING_FRACTION = 0.05;

export function nudgeSchedule(
  targetMinutes: number,
  settings: ClockSettings = currentSettings()
): NudgeSchedule {
  const targetMs = targetMinutes * 60_000;

  const wrapUpBeforeMs = settings.testMode
    ? targetMs * TEST_WRAP_UP_REMAINING_FRACTION
    : INTERVIEW.WRAP_UP_BEFORE_MS;

  const finalCallBeforeMs = settings.testMode
    ? targetMs * TEST_FINAL_CALL_REMAINING_FRACTION
    : INTERVIEW.FINAL_CALL_BEFORE_MS;

  return {
    // Clamped at zero: an interview shorter than the fixed offset would
    // otherwise schedule a timer in the past, which fires immediately and tells
    // the interviewer to wrap up before it has spoken.
    wrapUpAtMs: Math.max(0, targetMs - wrapUpBeforeMs),
    finalCallAtMs: Math.max(0, targetMs - finalCallBeforeMs),
    // The grace is deliberately NOT scaled. It exists so the interviewer can
    // finish a sentence rather than be cut off mid-word, and a sentence takes
    // the same few seconds however long the interview was.
    hardStopAtMs: targetMs + INTERVIEW.HARD_STOP_GRACE_MS,
  };
}

// The threshold the system prompt states, in whole minutes.
//
// Must name the same moment as `wrapUpAtMs`, or the interviewer is told to
// start closing at a time the server never signals — the failure the fixed
// WRAP_UP_AT_REMAINING_MIN getter was written to prevent, reintroduced by a
// shorter session if this were left constant.
//
// Floored at 1: a six-minute session's true threshold is 45 seconds, and
// "0 minutes or fewer remain" is an instruction that can never be satisfied.
export function wrapUpAtRemainingMinutes(
  targetMinutes: number,
  settings: ClockSettings = currentSettings()
): number {
  if (!settings.testMode) return INTERVIEW.WRAP_UP_AT_REMAINING_MIN;

  return Math.max(
    1,
    Math.ceil(targetMinutes * TEST_WRAP_UP_REMAINING_FRACTION)
  );
}
