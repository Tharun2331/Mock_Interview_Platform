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
const COURTESY_MAX_WORDS = 10;

// The sign-off tails, kept as their own alternation rather than spelled into
// one long pattern.
//
// "thank you have a good one" reached the Evaluator and scored 0/0/0, with
// coaching that the candidate had missed an entire question about Terraform and
// security. The pattern allowed "have a good day" and not "have a good one",
// which is the kind of gap a hand-written alternation always has — so the tail
// is now a list that can be extended without re-reading a regex.
const COURTESY_TAILS = [
  "so much",
  "very much",
  "for your time",
  "again",
  "bye",
  "goodbye",
  "you too",
  "have a good day",
  "have a good one",
  "have a great day",
  "have a nice day",
  "take care",
  "cheers",
  "appreciate it",
  "it was nice talking to you",
  "it was great talking to you",
].join("|");

const COURTESY_PATTERN = new RegExp(
  `^(ok|okay|alright|sure|yeah|yes|no)?\\s*` +
    `(thank you|thanks|thankyou|cheers)\\s*` +
    `((${COURTESY_TAILS})\\s*)*$`
);

// A farewell with no thanks in it at all — "have a good one", "you too".
// Separate from the pattern above because that one requires the thanks.
const FAREWELL_PATTERN = new RegExp(`^(ok|okay|alright|sure)?\\s*(${COURTESY_TAILS})$`);

// Asking about the session itself rather than answering the question.
//
// "how much time is left" scored 0/0/0 with coaching that a senior engineer
// would have acknowledged the closing gracefully. It is not an answer, it is
// the candidate asking the app a question — and the interview screen showing a
// countdown is the actual fix for them needing to ask at all.
//
// Capped like the others, and requiring the interrogative form: "we had about
// five minutes left on the migration" is an answer that mentions time.
const META_MAX_WORDS = 12;
const META_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(how much|how many minutes?|what s the|what is the) (time|minutes?) (is )?(left|remaining)\b/,
  /\bhow long (do we have|is left|have we got)\b/,
  /\b(are we|is this|is that) (done|finished|over|the last question)\b/,
  /\b(do you have|any) (any )?(other|more|further) questions?\b/,
  /\bis there anything else\b/,
  /\b(should|shall) (i|we) (keep going|continue|stop)\b/,
];

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

export type SkipReason = "courtesy" | "clarification" | "opener" | "meta";

export type ScoreableVerdict =
  | { scoreable: true }
  | { scoreable: false; reason: SkipReason };

export function classifyAnswer(transcript: string): ScoreableVerdict {
  const text = normalise(transcript);
  const words = wordCount(text);

  // Nothing said. ExchangeBuffer already declines to produce an exchange with
  // no answer, so this is belt and braces rather than a live path.
  if (words === 0) return { scoreable: false, reason: "courtesy" };

  if (
    words <= COURTESY_MAX_WORDS &&
    (COURTESY_PATTERN.test(text) || FAREWELL_PATTERN.test(text))
  ) {
    return { scoreable: false, reason: "courtesy" };
  }

  // Ahead of the clarification check: "do you have any other questions" is a
  // question about the session, not a request to hear one repeated.
  if (
    words <= META_MAX_WORDS &&
    META_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { scoreable: false, reason: "meta" };
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
