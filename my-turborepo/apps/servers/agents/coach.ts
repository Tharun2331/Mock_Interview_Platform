import {
  COACH_LIMITS,
  CoachReportSchema,
  trendDirection,
  type CoachReport,
  type RoadmapItem,
  type ScoreDimension,
  type Trend,
  type TrendPoint,
  type UserSessionSummary,
} from "@repo/shared";
import { converseStructured, type ToolInputSchema } from "../lib/bedrock";
import { extractJsonObject } from "../lib/modelJson";

// The Coach: where a candidate is heading, and what to work on next.
//
// v1 deliberately has no retrieval. No Knowledge Base, no citations, no vector
// store — that is v2. Everything here comes from rows this product already
// wrote about this candidate's own interviews.
//
// THE DIVISION OF LABOUR, which is the thing to hold onto before editing:
// every number in the report is computed here from stored data, and the model
// contributes only prose. Directions, score histories, averages and priorities
// are arithmetic. The model writes one line per trend and up to four focus
// points per roadmap item, and is handed the numbers as context it may describe
// but cannot change.
//
// That is why the spec's "do not invent sessions or scores" is not a prompt
// instruction here so much as a property of the shape: the tool schema has no
// field a score could be written into, and any topic the model returns that is
// not already in the input is dropped on merge. A model cannot fabricate a
// statistic it was never given a place to put.

/** The fallback when a session recorded no target role. Its own constant so the
 *  same string groups every such session rather than one per undefined. */
const UNLABELLED_TOPIC = "General practice";

// Ties resolve by a fixed order rather than arbitrarily, matching
// extremeDimensions in the shared package — two different orders for "which is
// worst" is how a roadmap and a history card end up disagreeing about the same
// session.
const DIMENSION_ORDER: readonly ScoreDimension[] = [
  "correctness",
  "clarity",
  "depth",
];

type TopicStats = {
  topic: string;
  /** Oldest first, which is the direction a chart is read in. */
  points: TrendPoint[];
  avgScore: number;
  weakDimension: ScoreDimension;
};

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function round(value: number): number {
  // One decimal, matching how the stored averages are already rounded. Two
  // decimals on a mean of means implies a precision the scores do not have.
  return Math.round(value * 10) / 10;
}

/**
 * The dimension a candidate is weakest at across a set of interviews.
 *
 * Prefers the stored `averages`, which are exact. Falls back to counting
 * `topWeakness` labels for rows written before averages were carried — a
 * candidate's existing history should still produce a roadmap rather than
 * being skipped for predating the attribute.
 */
export function weakestDimension(
  summaries: UserSessionSummary[]
): ScoreDimension {
  const withAverages = summaries.filter((row) => row.averages !== undefined);

  if (withAverages.length > 0) {
    const ranked = [...DIMENSION_ORDER].sort(
      (a, b) =>
        mean(withAverages.map((row) => row.averages?.[a] ?? 0)) -
        mean(withAverages.map((row) => row.averages?.[b] ?? 0))
    );
    return ranked[0] ?? "depth";
  }

  // Count the labels instead. Iterated in DIMENSION_ORDER so an even split
  // resolves the same way every time rather than by Map insertion order.
  const tally = new Map<ScoreDimension, number>();
  for (const row of summaries) {
    tally.set(row.topWeakness, (tally.get(row.topWeakness) ?? 0) + 1);
  }

  let worst: ScoreDimension = "depth";
  let seen = -1;
  for (const dimension of DIMENSION_ORDER) {
    const count = tally.get(dimension) ?? 0;
    if (count > seen) {
      seen = count;
      worst = dimension;
    }
  }
  return worst;
}

/**
 * Groups a candidate's finished interviews by what they were practising.
 *
 * "Topic" is the target role, because that is what a candidate actually varies
 * between sessions and it is the only subject label carried on these rows. See
 * the note in routes/coach.ts about what it would take to key this on something
 * finer.
 */
export function groupByTopic(
  summaries: UserSessionSummary[]
): TopicStats[] {
  const groups = new Map<string, UserSessionSummary[]>();

  for (const row of summaries) {
    const topic = (row.role ?? "").trim() || UNLABELLED_TOPIC;
    groups.set(topic, [...(groups.get(topic) ?? []), row]);
  }

  return [...groups.entries()].map(([topic, rows]) => {
    // Oldest first. The query returns newest-first because that is what the
    // history list wants; a trend line in that order reads improvement as
    // decline.
    const ordered = [...rows].sort((a, b) =>
      a.completedAt.localeCompare(b.completedAt)
    );

    return {
      topic,
      points: ordered.map((row) => ({
        date: row.completedAt,
        avgScore: row.overallScore,
      })),
      avgScore: round(mean(ordered.map((row) => row.overallScore))),
      weakDimension: weakestDimension(ordered),
    };
  });
}

/**
 * The whole report, minus the prose.
 *
 * Pure and exported: this is where every claim the Coach makes is actually
 * decided, so it is the part worth testing directly and without a model.
 */
export function analyseHistory(summaries: UserSessionSummary[]): {
  trends: Omit<Trend, "summary">[];
  roadmap: Omit<RoadmapItem, "focusPoints">[];
} {
  const stats = groupByTopic(summaries);

  const trends = stats
    // A trend needs two points. One interview is a position, and reporting it
    // as "flat" would claim a stability the data cannot show.
    .filter((entry) => entry.points.length >= COACH_LIMITS.MIN_SESSIONS_FOR_TREND)
    // Most-practised first: a topic with six interviews behind it has a more
    // trustworthy line than one with two, and the cap should keep the former.
    .sort((a, b) => b.points.length - a.points.length)
    .slice(0, COACH_LIMITS.MAX_TRENDS)
    .map((entry) => ({
      topic: entry.topic,
      direction: trendDirection(entry.points.map((point) => point.avgScore)),
      scoreHistory: entry.points,
    }));

  const roadmap = stats
    // Worst first, so priority 1 is the thing most worth doing next. Ties break
    // on topic name to keep the ordering stable across identical inputs.
    .sort((a, b) => a.avgScore - b.avgScore || a.topic.localeCompare(b.topic))
    .slice(0, COACH_LIMITS.MAX_ROADMAP_ITEMS)
    .map((entry, index) => ({
      topic: entry.topic,
      avgScore: entry.avgScore,
      weakDimension: entry.weakDimension,
      priority: index + 1,
    }));

  return { trends, roadmap };
}

const COACH_TOOL_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    topics: {
      type: "array",
      items: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description: "Copied exactly from the input. Never a new topic.",
          },
          summary: {
            type: "string",
            description:
              "One sentence on how this topic is going, in the second person.",
          },
          focusPoints: {
            type: "array",
            maxItems: COACH_LIMITS.MAX_FOCUS_POINTS,
            items: {
              type: "string",
              description: "One concrete thing to practise before the next round.",
            },
          },
        },
        required: ["topic", "summary", "focusPoints"],
      },
    },
  },
  required: ["topics"],
};

const SYSTEM_PROMPT = [
  "You are writing study advice from a candidate's own interview scores.",
  "Only write about the topics listed in the input. Never introduce a new one.",
  "Never state a score, a date, or a session count — those are supplied already.",
  "Summaries: one sentence, second person, describing the direction given.",
  "Focus points: concrete and practisable, aimed at the named weak dimension.",
  "correctness = accuracy. clarity = how it was said. depth = how far it went.",
  "Say less when the data is thin. Two interviews is a hint, not a verdict.",
].join("\n");

function buildPrompt(
  trends: Omit<Trend, "summary">[],
  roadmap: Omit<RoadmapItem, "focusPoints">[]
): string {
  const lines: string[] = [];

  for (const item of roadmap) {
    const trend = trends.find((entry) => entry.topic === item.topic);
    lines.push(
      `TOPIC: ${item.topic}`,
      `- interviews: ${trend?.scoreHistory.length ?? 1}`,
      `- average score: ${item.avgScore} out of 10`,
      `- weakest dimension: ${item.weakDimension}`,
      `- direction: ${trend?.direction ?? "not enough interviews to say"}`,
      ""
    );
  }

  return lines.join("\n");
}

/** What the model is allowed to contribute, keyed by topic. */
type Prose = Map<string, { summary: string; focusPoints: string[] }>;

function toCandidateObject(value: unknown): unknown {
  return typeof value === "string" ? extractJsonObject(value, "Coach") : value;
}

// Never throws. A failed generation costs the report its prose, not its
// numbers — and the numbers are the part a candidate cannot work out for
// themselves. One attempt for the same reason Company Intel takes one: the
// fallback is already a usable answer.
async function writeProse(
  trends: Omit<Trend, "summary">[],
  roadmap: Omit<RoadmapItem, "focusPoints">[]
): Promise<Prose> {
  const prose: Prose = new Map();
  if (roadmap.length === 0) return prose;

  try {
    const result = await converseStructured({
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(trends, roadmap),
      toolName: "record_coaching_notes",
      toolDescription: "Record one summary and up to four focus points per topic.",
      inputSchema: COACH_TOOL_SCHEMA,
    });

    const value = toCandidateObject(result.value);
    const topics =
      typeof value === "object" && value !== null && "topics" in value
        ? (value as { topics: unknown }).topics
        : undefined;

    if (!Array.isArray(topics)) return prose;

    for (const entry of topics) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.topic !== "string") continue;

      // The guard that makes invention impossible rather than merely
      // discouraged: a topic the analysis did not produce is discarded, so the
      // model cannot add a subject the candidate never practised.
      if (!roadmap.some((item) => item.topic === row.topic)) continue;

      prose.set(row.topic, {
        summary:
          typeof row.summary === "string"
            ? row.summary.slice(0, COACH_LIMITS.MAX_SUMMARY_CHARS)
            : "",
        focusPoints: Array.isArray(row.focusPoints)
          ? row.focusPoints
              .filter((point): point is string => typeof point === "string")
              .map((point) => point.trim().slice(0, COACH_LIMITS.MAX_FOCUS_POINT_CHARS))
              .filter((point) => point.length > 0)
              .slice(0, COACH_LIMITS.MAX_FOCUS_POINTS)
          : [],
      });
    }
  } catch (error) {
    console.warn(
      `[coach] prose generation failed, returning numbers only — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  return prose;
}

// Stated from the numbers when the model gave nothing. Plain rather than
// encouraging: an automated sentence pretending to be a coach reads worse than
// one that simply reports.
function fallbackSummary(trend: Omit<Trend, "summary">): string {
  const rounds = trend.scoreHistory.length;
  const phrase =
    trend.direction === "improving"
      ? "scores are rising"
      : trend.direction === "declining"
        ? "scores are slipping"
        : "scores are holding steady";

  return `${trend.topic}: ${phrase} across ${rounds} interviews.`.slice(
    0,
    COACH_LIMITS.MAX_SUMMARY_CHARS
  );
}

export type CoachAgentInput = {
  summaries: UserSessionSummary[];
};

/**
 * One typed input object in, one typed output object out — the same shape as
 * every other agent, so v2 can wrap it without touching the call site.
 *
 * Returns an empty report for a candidate with no finished interviews, without
 * calling Bedrock. There is nothing to coach and nothing to say about it, and
 * paying a model to observe that would be paying for the word "none".
 */
export async function runCoachAgent(
  input: CoachAgentInput
): Promise<CoachReport> {
  const { trends, roadmap } = analyseHistory(input.summaries);

  if (roadmap.length === 0) return { trends: [], roadmap: [] };

  const prose = await writeProse(trends, roadmap);

  const report: CoachReport = {
    trends: trends.map((trend) => {
      const written = prose.get(trend.topic)?.summary ?? "";
      return {
        ...trend,
        summary: written.length > 0 ? written : fallbackSummary(trend),
      };
    }),
    roadmap: roadmap.map((item) => ({
      ...item,
      focusPoints: prose.get(item.topic)?.focusPoints ?? [],
    })),
  };

  // Validated against the same schema the route returns, so a bug here surfaces
  // as a caught error rather than as a malformed body the client has to guess
  // at. Parsed rather than asserted: this is the last point where the shape is
  // still ours to check.
  return CoachReportSchema.parse(report);
}
