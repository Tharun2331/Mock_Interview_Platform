import { z } from "zod";
import { EVALUATION_LIMITS, ScoreDimensionSchema } from "./evaluation";

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
  scoreHistory: z.array(TrendPointSchema).min(COACH_LIMITS.MIN_SESSIONS_FOR_TREND),
  summary: z.string().min(1).max(COACH_LIMITS.MAX_SUMMARY_CHARS),
});

export type Trend = z.infer<typeof TrendSchema>;

export const RoadmapItemSchema = z.object({
  topic: z.string().min(1).max(COACH_LIMITS.MAX_TOPIC_CHARS),
  avgScore: z.number().min(0).max(EVALUATION_LIMITS.MAX_SCORE),
  weakDimension: ScoreDimensionSchema,
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
