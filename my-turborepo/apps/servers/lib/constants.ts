// Tuning values for Bedrock calls. Kept out of the agents so the numbers are
// reviewable in one place rather than scattered through prompt code.
export const BEDROCK = {
  // A plan is a handful of focus areas plus a sentence or two. Capping this
  // matters: output tokens are the expensive half of Bedrock pricing, and an
  // unbounded limit lets a rambling model quietly multiply per-request cost.
  //
  // Raised from 512 when focus areas grew from bare strings to
  // `{area, evidence, source}` and `roleSpecific`/`targetMinutes` landed. Six
  // areas with real evidence lines no longer fit in 512, and a plan truncated
  // mid-JSON fails validation and costs the full generation anyway.
  MAX_TOKENS: 768,
  // Lowered from 0.3 alongside the schema change. Structured JSON from an 8B
  // model gains more from determinism than the plan gains from variety, and
  // the few-shot exemplar now supplies the shape that temperature used to
  // have to guess at.
  TEMPERATURE: 0.2,
  // A 768-token plan from an 8B model lands in a couple of seconds. Anything
  // past this is a stalled socket, not a slow model — and the caller is a
  // person watching a progress bar, so failing over to the next model beats
  // waiting. Applied per HTTP attempt, so the worst case is roughly this
  // times the length of the fallback chain.
  REQUEST_TIMEOUT_MS: 30_000,
  CONNECTION_TIMEOUT_MS: 5_000,
  // One attempt, not the SDK's default of three.
  //
  // Retries and a fallback chain are the same mechanism applied twice, and
  // stacking them multiplies: a model that accepts the connection and then
  // sends nothing cost 3 x REQUEST_TIMEOUT_MS before the chain even moved on.
  // Measured at 92s on a request a candidate was watching a progress bar for.
  // Falling straight to the next model is both faster and more likely to work
  // than asking a stalled one again.
  MAX_ATTEMPTS: 1,
} as const;

// Tool names the Mock Interview agent calls over the Sonic stream. Referenced
// by both the system prompt and the tool specs, and later by the dispatcher on
// the WebSocket side, so a rename cannot desync the prompt from the handler.
export const INTERVIEW_TOOL_NAMES = {
  LOG_EXCHANGE: "logExchange",
  GET_SESSION_STATE: "getSessionState",
  END_INTERVIEW: "endInterview",
} as const;

// Pacing bounds for the live interview. These are prompt guidance, not
// enforcement — nothing can stop a spoken conversation mid-sentence — but they
// keep the interviewer from either abandoning a topic after one answer or
// grinding on it until the clock runs out.
export const INTERVIEW = {
  MIN_EXCHANGES_PER_AREA: 2,
  MAX_EXCHANGES_PER_AREA: 4,
  // Follow-ups allowed on one thread before the interviewer must change
  // subject. Observed without it: four consecutive rephrasings of the same
  // cache-invalidation question, continuing past "I'm not too sure" — which
  // reads as interrogation rather than interviewing.
  MAX_FOLLOWUPS_PER_THREAD: 2,
  // How long before the planned end the interviewer is told to start wrapping
  // up. Enough for a closing question and a warm sign-off.
  WRAP_UP_BEFORE_MS: 3 * 60 * 1000,
  // The same threshold in whole minutes, because the prompt states it to a
  // model that reads minutes and cannot divide milliseconds. Derived rather
  // than written twice: the nudge the server sends and the rule the prompt
  // states have to name the same moment, or the interviewer is told to wrap up
  // at a time it was never taught to recognise.
  get WRAP_UP_AT_REMAINING_MIN(): number {
    return Math.round(this.WRAP_UP_BEFORE_MS / 60_000);
  },
  // Second, blunter nudge, sent this long before the planned end.
  //
  // The wrap-up nudge is one text turn injected into a live conversation. If it
  // lands while the candidate is mid-answer it competes with their speech for
  // the model's next turn, and a measured session showed exactly that: the
  // nudge fired at T-3, the interviewer kept opening new threads, and the
  // candidate ended up asking how much time was left. One delivery attempt at a
  // single instant is not a mechanism — this is the second attempt.
  FINAL_CALL_BEFORE_MS: 60 * 1000,
  // Grace after targetMinutes before the session is closed regardless. The
  // prompt's time budget is advisory and the model overran it by eight minutes
  // in a measured 48-minute session, so the clock is enforced in code.
  HARD_STOP_GRACE_MS: 60 * 1000,
} as const;

// Nova 2 Sonic stream settings. Separate from BEDROCK above because the voice
// path shares nothing with the text path — different command, different request
// handler, different billing model.
export const SONIC = {
  MODEL_ID: "amazon.nova-2-sonic-v1:0",
  // Fixed by what Sonic accepts and emits, not preferences. The browser's
  // AudioWorklet must produce exactly INPUT_SAMPLE_RATE and the player must
  // schedule exactly OUTPUT_SAMPLE_RATE, or audio arrives pitched wrong.
  INPUT_SAMPLE_RATE: 16000,
  OUTPUT_SAMPLE_RATE: 24000,
  SAMPLE_SIZE_BITS: 16,
  CHANNEL_COUNT: 1,
  VOICE_ID: "matthew",
  // A two-sentence spoken turn is roughly 50 tokens. 200 leaves headroom while
  // bounding the damage when the prompt's limit is ignored — which it was, in a
  // measured session where single turns carried three stacked questions.
  MAX_TOKENS: 200,
  TOP_P: 0.9,
  TEMPERATURE: 0.7,
  // How eagerly Sonic decides the candidate has stopped talking. MEDIUM is the
  // documented default; LOW waits longer, which may suit someone thinking
  // through a hard technical question. Worth retuning against real speech.
  ENDPOINTING_SENSITIVITY: "MEDIUM",
  // Transport inactivity timeouts, deliberately well beyond the 8-minute cap
  // Bedrock itself puts on a bidirectional stream.
  //
  // These were 300_000 — five minutes — copied from the AWS sample, whose demo
  // sessions are short. That is close enough to a real interview's length to
  // look like a mysterious mid-conversation disconnect, and it would pre-empt
  // the actual limit and make it impossible to tell the two apart. The
  // semantic controls (IDLE_TIMEOUT_MS, MAX_SESSION_MS) are the ones meant to
  // end a session; the transport should not have an opinion.
  REQUEST_TIMEOUT_MS: 900_000,
  SESSION_TIMEOUT_MS: 900_000,
  // A stream with no inbound audio for this long is an abandoned tab, not a
  // thoughtful pause. Sonic bills by open duration, so this is a cost control
  // first and a UX one second.
  IDLE_TIMEOUT_MS: 120_000,
  // Hard ceiling on a single interview regardless of activity.
  //
  // NOT the binding limit. Bedrock closes a bidirectional stream after roughly
  // 8 minutes regardless of what is set here, and the documented way to run
  // longer is to open a fresh stream and replay the conversation history. Any
  // plan with targetMinutes above ~8 therefore needs that renewal to exist —
  // this value only bounds the total across renewals.
  MAX_SESSION_MS: 90 * 60 * 1000,
  // How long Bedrock allows one stream to stay open. Measured at roughly 7m19s
  // of conversation in a real session, so 8 minutes is the ceiling rather than
  // a guess. Renewal starts before this, not after — waiting for the stream to
  // die means the candidate is mid-answer when it happens.
  STREAM_LIFETIME_MS: 8 * 60 * 1000,
  // Renewal begins this long before the ceiling. Wide enough to absorb a slow
  // stream open (~400ms measured) plus the history replay, narrow enough that
  // it does not throw away usable stream time on every cycle.
  RENEW_BEFORE_MS: 90 * 1000,
  // How many past exchanges are replayed into a renewed stream. The whole
  // conversation would grow the prompt without bound across renewals, and the
  // interviewer only needs enough context to keep the thread — the session
  // brief in the system prompt carries the rest.
  MAX_REPLAYED_EXCHANGES: 6,
  // Audio is dropped rather than buffered without bound when the client
  // outruns the stream. 200 frames at 32ms each is roughly six seconds.
  MAX_QUEUED_AUDIO_FRAMES: 200,
  // Liveness probe. `ws` gives us ping/pong; a socket that misses two in a row
  // is gone, and the Sonic stream behind it must not outlive it.
  HEARTBEAT_MS: 30_000,
} as const;

import { RESUME_LIMITS, UPLOAD_FIELDS } from "@repo/shared";

export const UPLOAD = {
  RESUME_FIELD: UPLOAD_FIELDS.RESUME,
  GITHUB_FIELD: UPLOAD_FIELDS.GITHUB,
  // Sourced from @repo/shared so the browser rejects at exactly the limit the
  // server enforces — and both quote the same number back to the user.
  MAX_RESUME_BYTES: RESUME_LIMITS.MAX_BYTES,
  RESUME_MIME: RESUME_LIMITS.MIME,
  // Multipart framing — boundaries, part headers, the sibling text field — sits
  // on top of the file itself, so the whole-body budget has to be a little
  // larger than the per-file limit or a file exactly at the cap is refused.
  BODY_OVERHEAD_BYTES: 8 * 1024,
  // Every PDF starts with this. The `type` on an uploaded File is whatever the
  // client claimed, so the header is the only trustworthy signal.
  PDF_MAGIC: "%PDF-",
  MIN_USEFUL_RESUME_CHARS: RESUME_LIMITS.MIN_USEFUL_CHARS,
} as const;

// Resume PII stripping, applied once at profile save before the text is stored
// or shown to any model.
export const REDACTION = {
  // Comprehend's full PII entity set is English-only. A resume in another
  // language still gets the deterministic pass, which is language-independent.
  LANGUAGE_CODE: "en",
  // Deliberately low. A false positive costs one stripped word the Planner
  // could have used; a false negative puts a candidate's home address into a
  // model prompt and a database. The asymmetry is not close, so this favours
  // recall over precision.
  MIN_CONFIDENCE: 0.5,
  // DetectPiiEntities' real-time ceiling. Unreachable in practice —
  // PLAN_LIMITS.MAX_RESUME_CHARS caps the input at 20k characters, roughly a
  // quarter of this — and the redactor throws rather than chunking if it is
  // ever crossed. See the note in lib/redact.ts on why silent chunking is the
  // wrong failure mode here.
  MAX_BYTES: 100_000,
  // Retries are safe here, unlike the Bedrock path: the call is idempotent,
  // sub-second, and has no fallback chain behind it to make a second attempt
  // redundant.
  MAX_ATTEMPTS: 2,
  REQUEST_TIMEOUT_MS: 10_000,
} as const;

// How much candidate material goes into the prompt. These are cost and
// relevance controls, not correctness ones — the plan is only as good as the
// signal here, but every extra character is an input token on every request.
//
// Validation bounds for the plan itself live in `PLAN_LIMITS` in
// `@repo/shared`, so the schema and the prompt cannot disagree.
export const PROMPT = {
  // Repos are sent highest-starred first; the long tail of forks and
  // scratch projects says little about what a candidate can be asked.
  MAX_REPOS: 15,
  MAX_REPO_DESCRIPTION_CHARS: 160,
  // Enough for a two-page resume. Truncation is preferred over rejection:
  // a plan from a partial resume beats no plan at all.
  MAX_RESUME_CHARS: 4_000,
} as const;
