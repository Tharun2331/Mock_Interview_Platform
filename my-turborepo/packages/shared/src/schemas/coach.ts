import { z } from "zod";
import { EVALUATION_LIMITS } from "./evaluation";
import { ITEM_TYPE } from "./session";

// What the Coach produces: where a candidate is heading, and what to work on.
//
// v1 is trend analysis plus a study roadmap. No retrieval, no Knowledge Base,
// no citations — that is v2, and the absence is deliberate rather than
// unfinished. There is a `SessionCoachSchema` in session.ts carrying `plan` and
// `citations` which was sketched for the RAG version; it is not what this
// produces and nothing here writes it.
//
// The division of labour is the thing to understand before editing this file.
// Every NUMBER here is computed from stored rows — score histories, averages,
// directions, priorities. The model contributes only prose: one line per trend
// and up to four focus points per roadmap item. A model cannot invent a score
// it was never asked to produce, which is a stronger guarantee than instructing
// it not to.

export const COACH_LIMITS = {
  // Two points is the minimum that can have a direction. A single interview is
  // a position, not a trend, and reporting one as "flat" would be a claim the
  // data does not support.
  MIN_SESSIONS_FOR_TREND: 2,
  // Enough to cover the roles a candidate actually rehearses. Past this the
  // report stops being a plan and becomes a list.
  MAX_TRENDS: 6,
  // Up to two per topic now that the roadmap has tracks, so this caps roughly
  // three topics rather than six. Past that a study plan stops being a plan.
  MAX_ROADMAP_ITEMS: 6,
  MAX_FOCUS_POINTS: 4,
  MAX_TOPIC_CHARS: 200,
  // One line, and enforced rather than requested — a paragraph here turns the
  // report into something nobody reads to the end of.
  MAX_SUMMARY_CHARS: 240,
  MAX_FOCUS_POINT_CHARS: 200,
  // How far two means must diverge before a direction is claimed. Below this,
  // the movement is noise from a different set of questions rather than a
  // change in the candidate, and calling it improvement would be flattery.
  TREND_EPSILON: 0.5,
} as const;

export const TrendDirectionSchema = z.enum(["improving", "declining", "flat"]);

export type TrendDirection = z.infer<typeof TrendDirectionSchema>;

/** One interview's contribution to a trend line. */
export const TrendPointSchema = z.object({
  date: z.iso.datetime(),
  avgScore: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
});

export type TrendPoint = z.infer<typeof TrendPointSchema>;

export const TrendSchema = z.object({
  topic: z.string().min(1).max(COACH_LIMITS.MAX_TOPIC_CHARS),
  direction: TrendDirectionSchema,
  // Oldest first. The history page's card list runs newest-first because that
  // is what a list wants; a line chart read right-to-left shows improvement as
  // decline, so the ordering is opposite here and deliberately so.
  //
  // `.min(2)` is the schema enforcing the rule above: a trend with one point
  // cannot be constructed, so "single session produces no trend" is a property
  // of the type rather than a branch someone can forget.
  scoreHistory: z
    .array(TrendPointSchema)
    .min(COACH_LIMITS.MIN_SESSIONS_FOR_TREND),
  summary: z.string().min(1).max(COACH_LIMITS.MAX_SUMMARY_CHARS),
});

export type Trend = z.infer<typeof TrendSchema>;

// Two tracks, because they are learned differently and evidenced differently.
//
// `communication` is how an answer was delivered — structure, order, getting to
// the point. It is measured directly: clarity is scored on every answer, so a
// claim about it rests on a number that was actually assigned.
//
// `technical` is what the candidate knows. Nothing in this product tests that
// directly — it reads correctness and depth off answers to questions the
// interviewer happened to ask, which is a sample, not an exam.
export const RoadmapTrackSchema = z.enum(["communication", "technical"]);

export type RoadmapTrack = z.infer<typeof RoadmapTrackSchema>;

// How much weight the reader should put on an item.
//
// Stated in the data rather than hedged in the prose, so the UI can mark it and
// a candidate can see which advice is grounded and which is inferred. The
// technical track is always tentative: "you seem shaky on caching" drawn from
// two questions that touched caching is a pattern, not a diagnosis, and
// presenting it with the same confidence as a clarity score would be
// overclaiming on the strength of a small sample.
export const CoachConfidenceSchema = z.enum(["confident", "tentative"]);

export type CoachConfidence = z.infer<typeof CoachConfidenceSchema>;

export const RoadmapItemSchema = z.object({
  topic: z.string().min(1).max(COACH_LIMITS.MAX_TOPIC_CHARS),
  avgScore: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
  track: RoadmapTrackSchema,
  confidence: CoachConfidenceSchema,
  // May be empty. The numbers are computed and the prose is generated, so a
  // failed model call costs a candidate the advice and not the roadmap — the
  // topic, its score and its weakest dimension are still worth reading.
  focusPoints: z
    .array(z.string().min(1).max(COACH_LIMITS.MAX_FOCUS_POINT_CHARS))
    .max(COACH_LIMITS.MAX_FOCUS_POINTS),
  // 1 is the most urgent. Assigned by ascending average score, so the thing a
  // candidate is worst at is the thing they are told to do first.
  priority: z.number().int().min(1),
});

export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

export const CoachReportSchema = z.object({
  // Empty for a candidate with no finished interviews, and for one who has
  // done exactly one. Both are honest outcomes rather than errors.
  trends: z.array(TrendSchema).max(COACH_LIMITS.MAX_TRENDS),
  roadmap: z.array(RoadmapItemSchema).max(COACH_LIMITS.MAX_ROADMAP_ITEMS),
});

export type CoachReport = z.infer<typeof CoachReportSchema>;

/**
 * Which way a series of scores is going.
 *
 * Compares the mean of the first half against the mean of the second half
 * rather than the first point against the last, which would let either endpoint
 * define the whole direction on its own.
 *
 * This damps an outlier rather than neutralising it, and the difference is
 * worth being honest about: a spike in the middle is averaged away against its
 * neighbours, but five steady rounds followed by a bad one still reads as a
 * decline. That is the intended behaviour — a bad finish is a signal — it is
 * simply proportionate to the series instead of being the whole of it.
 *
 * Exported because it is the one piece of Coach arithmetic worth testing
 * directly — everything else composes from it.
 */
export function trendDirection(scores: number[]): TrendDirection {
  if (scores.length < COACH_LIMITS.MIN_SESSIONS_FOR_TREND) return "flat";

  const middle = Math.floor(scores.length / 2);
  // With an odd count the middle reading belongs to neither half. Dropping it
  // keeps the two halves the same size, so a short series is not weighted
  // toward whichever end happens to have the extra point.
  const earlier = scores.slice(0, middle);
  const later = scores.slice(scores.length % 2 === 0 ? middle : middle + 1);

  const mean = (values: number[]): number =>
    values.reduce((total, value) => total + value, 0) / values.length;

  const delta = mean(later) - mean(earlier);

  if (delta >= COACH_LIMITS.TREND_EPSILON) return "improving";
  if (delta <= -COACH_LIMITS.TREND_EPSILON) return "declining";
  return "flat";
}

// ---------------------------------------------------------------------------
// The cache
// ---------------------------------------------------------------------------
//
// USER#<uid> / COACH. The same machine as the plan cache one partition over: a
// DynamoDB item, a stamp compared on read, and no cache library anywhere. See
// ADR-0006 for why there is no Redis in this stack.
//
// ONLY THE PROSE IS CACHED. Every number in a report is recomputed from the
// summary rows on each request, because those are free and caching them makes a
// stale score representable — a repaired or backfilled row would otherwise keep
// serving its old figure until the candidate finished another interview.

/** What the model contributed for one topic, in a shape that can be stored. */
export const CoachTopicProseSchema = z.object({
  topic: z.string().min(1).max(COACH_LIMITS.MAX_TOPIC_CHARS),
  summary: z.string().max(COACH_LIMITS.MAX_SUMMARY_CHARS),
  communicationFocus: z
    .array(z.string().min(1).max(COACH_LIMITS.MAX_FOCUS_POINT_CHARS))
    .max(COACH_LIMITS.MAX_FOCUS_POINTS),
  technicalFocus: z
    .array(z.string().min(1).max(COACH_LIMITS.MAX_FOCUS_POINT_CHARS))
    .max(COACH_LIMITS.MAX_FOCUS_POINTS),
});

export type CoachTopicProse = z.infer<typeof CoachTopicProseSchema>;

export const CoachProseSchema = z.object({
  topics: z.array(CoachTopicProseSchema).max(COACH_LIMITS.MAX_TRENDS),
});

export type CoachProse = z.infer<typeof CoachProseSchema>;

/**
 * Bumped whenever the prompt or the shape of the prose changes.
 *
 * Without it, a deploy that improves the advice leaves every existing candidate
 * pinned to output from the old prompt until they finish another interview —
 * silently, because nothing else about their data changed. It is the one
 * invalidation trigger that has no signal in the data at all.
 */
// 2 (2026-09-23): the prompt gained a plain-text rule and the agent gained a
// deterministic markdown strip. Every cached report written before this carries
// literal asterisks in its prose, and nothing else about those candidates' data
// changed — so without this bump they would keep reading "*why*" until they
// happened to finish another interview. This is exactly the case the field
// exists for.
export const COACH_CACHE_VERSION = 2;

/**
 * The fingerprint of the inputs a report was built from.
 *
 * Four fields, one per thing that can change a report:
 *
 *   rowCount          a session finished, or an old one aged out via TTL
 *   latestCompletedAt disambiguates an equal count — one row expiring while
 *                     another lands leaves rowCount unchanged
 *   summarisedCount   THE SUBTLE ONE. A history row is written when a session
 *                     completes and its narrative is attached moments later by
 *                     the summarizer. A report generated in that window was
 *                     built without the narrative, and neither of the two
 *                     fields above changes when it arrives
 *   version           a deploy changed the prompt
 */
export const CoachCacheStampSchema = z.object({
  rowCount: z.number().int().min(0),
  latestCompletedAt: z.string(),
  summarisedCount: z.number().int().min(0),
  version: z.number().int().min(1),
});

export type CoachCacheStamp = z.infer<typeof CoachCacheStampSchema>;

export const CachedCoachSchema = z.object({
  type: z.literal(ITEM_TYPE.CACHED_COACH).default(ITEM_TYPE.CACHED_COACH),
  stamp: CoachCacheStampSchema,
  prose: CoachProseSchema,
  generatedAt: z.iso.datetime(),
});

export type CachedCoach = z.infer<typeof CachedCoachSchema>;

/** Derived from the rows the request already read, so the freshness check costs
 *  no extra reads — the same property that makes the plan cache free. */
export function coachCacheStamp(
  summaries: ReadonlyArray<{ completedAt: string; summary?: unknown }>,
): CoachCacheStamp {
  // Max rather than first: the caller's ordering is not this function's
  // business, and a reversed list must not produce a different stamp.
  const latest = summaries.reduce(
    (newest, row) => (row.completedAt > newest ? row.completedAt : newest),
    "",
  );

  return {
    rowCount: summaries.length,
    latestCompletedAt: latest,
    summarisedCount: summaries.filter((row) => row.summary !== undefined)
      .length,
    version: COACH_CACHE_VERSION,
  };
}

/**
 * Whether a cached report still describes the current inputs.
 *
 * Pull-based, and that is the design decision rather than an implementation
 * detail. The alternative — having the summarizer delete this row when it
 * attaches a narrative — has a failure this codebase has already been bitten
 * by: if the attach succeeds and the delete does not, the cache is stale
 * forever with nothing that will ever look again. The same shape as the
 * `completedCount` problem, in a system where at-least-once is what you get.
 *
 * Comparing a fingerprint on read cannot miss an invalidation, because nothing
 * has to remember to invalidate.
 */
export function isCachedCoachFresh(args: {
  cached: CachedCoach;
  stamp: CoachCacheStamp;
}): boolean {
  const a = args.cached.stamp;
  const b = args.stamp;

  return (
    a.rowCount === b.rowCount &&
    a.latestCompletedAt === b.latestCompletedAt &&
    a.summarisedCount === b.summarisedCount &&
    a.version === b.version
  );
}
