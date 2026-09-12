// Whether a recorded exchange is an answer worth scoring.
//
// The transcript keeps everything that was said — it is the durable record of
// the conversation and the Coach reads it. This decides only what gets an
// EVAL# item, because a few things a candidate says are not attempts at the
// question and scoring them produces nonsense.
//
// Two categories, both observed in real sessions:
//
//   "thank you"                      -> scored 0/0/0 and the coaching read
//                                       "a senior engineer would leave with a
//                                       memorable line", as if a sign-off were
//                                       a failed answer
//   "could you please repeat it"     -> scored 0/0/0 with "you missed the
//                                       question entirely, which is a critical
//                                       failure", for asking to hear it again
//
// Both dragged the whole-interview averages down: one session had five such
// zeros out of thirty-one exchanges.
//
// What is deliberately NOT filtered: "I don't know", "I'm not too sure", and
// "let's move to a different question". Those ARE answers — the candidate
// engaged with the question and could not answer it, which is exactly the
// signal an interview is meant to surface. Filtering them would flatter the
// score and hide the thing the candidate most needs to see.

// Speech transcripts arrive lowercase and unpunctuated, but normalising makes
// this independent of that and survives a change of ASR.
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(normalised: string): number {
  return normalised.length === 0 ? 0 : normalised.split(" ").length;
}

// A closing acknowledgement and nothing else.
//
// Length-capped rather than matched loosely: a real answer can thank the
// interviewer on its way past, and "thanks — so the way I'd approach that is…"
// must still be scored. Only an utterance that is ENTIRELY courtesy counts.
const COURTESY_MAX_WORDS = 8;
const COURTESY_PATTERN =
  /^(ok|okay|alright|sure|yeah|yes|no)?\s*(thank you|thanks|thank you so much|thankyou)\s*(so much|very much|for your time|again|bye|have a good day|you too)?$/;

// Asking to hear the question again.
//
// Capped too, for the same reason: "could you repeat the second part — but on
// the first, what I did was…" is an answer with a clarification inside it, not
// a request instead of an answer.
const CLARIFICATION_MAX_WORDS = 16;

// Every pattern requires the REQUEST form, not merely the word "repeat" or
// "say". An earlier version made each group optional, which collapsed the first
// pattern to a bare \b(repeat|say)\b and skipped six genuine answers in a probe
// — "i would say the main tradeoff is latency", "we repeat the request with
// exponential backoff". That is the failure that matters here: an unscored
// pleasantry costs one odd card, while a filtered real answer silently deletes
// feedback the candidate earned and lowers the denominator with it.
//
// Under-filtering is therefore the deliberate bias. A phrasing that slips
// through is scored, which is exactly what happens today.
const CLARIFICATION_PATTERNS: ReadonlyArray<RegExp> = [
  // Addressed to the interviewer: "could you repeat", "can you say that again".
  /\b(could|can|would|will) you (please )?(repeat|say (that|it) again)\b/,
  /\bplease (repeat|say (that|it) again)\b/,
  // Imperative with an explicit object AND a repetition marker, so "repeat the
  // migration for each table" does not match.
  /\b(repeat|say) (that|it|the question)( again| one more time| once more)\b/,
  /\bi (didn t|did not|didnt) (get|catch|hear|follow) (your |the )?(question|that)\b/,
  /\b(sorry|pardon)\b.*\b(what was that|come again|say that again)\b/,
  /\bcome again\b/,
  /\b(one more time|once more) please\b/,
];

// An utterance made entirely of discourse markers — the sound of starting to
// answer, with no answer in it.
//
// Observed as "sure so", captured when the interviewer closed the interview
// while the candidate was drawing breath. It scored 0/0/0 with coaching that
// they should have named JWT or OAuth, which blames a candidate for being cut
// off mid-syllable.
//
// Distinct from a short but real attempt: "the day one" and "redux" are
// answers, poor ones, and they are scored. The test is whether anything
// content-bearing was said at all, not how much.
const OPENER_MAX_WORDS = 4;
const OPENER_WORDS = new Set([
  "so",
  "sure",
  "yeah",
  "yes",
  "ok",
  "okay",
  "alright",
  "right",
  "well",
  "um",
  "uh",
  "erm",
  "hmm",
  "like",
  "and",
  "i",
]);

export type SkipReason = "courtesy" | "clarification" | "opener";

export type ScoreableVerdict =
  | { scoreable: true }
  | { scoreable: false; reason: SkipReason };

export function classifyAnswer(transcript: string): ScoreableVerdict {
  const text = normalise(transcript);
  const words = wordCount(text);

  // Nothing said. ExchangeBuffer already declines to produce an exchange with
  // no answer, so this is belt and braces rather than a live path.
  if (words === 0) return { scoreable: false, reason: "courtesy" };

  if (words <= COURTESY_MAX_WORDS && COURTESY_PATTERN.test(text)) {
    return { scoreable: false, reason: "courtesy" };
  }

  if (
    words <= CLARIFICATION_MAX_WORDS &&
    CLARIFICATION_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { scoreable: false, reason: "clarification" };
  }

  // Capped at four words so this can only ever catch an abandoned opening. A
  // longer utterance has said something even if it said it badly.
  if (
    words <= OPENER_MAX_WORDS &&
    text.split(" ").every((word) => OPENER_WORDS.has(word))
  ) {
    return { scoreable: false, reason: "opener" };
  }

  return { scoreable: true };
}

export function isScoreableAnswer(transcript: string): boolean {
  return classifyAnswer(transcript).scoreable;
}
