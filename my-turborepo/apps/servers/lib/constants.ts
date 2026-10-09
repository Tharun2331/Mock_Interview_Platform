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

// The text agents' guardrail (ADR-0010). See lib/guardrail.ts.
export const GUARDRAIL = {
  // Converse's stopReason when the guardrail blocked the input or the output.
  // The reply text is then the guardrail's canned message, not a generation.
  INTERVENED_STOP_REASON: "guardrail_intervened",
  // ApplyGuardrail's `action` for the same outcome. A different string from a
  // different API: the standalone call reports it in its own vocabulary.
  INTERVENED_ACTION: "GUARDRAIL_INTERVENED",
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
  // A claimed quota slot is given back when the interview ends within this long
  // of the stream opening AND produced no scoreable answer — a failed startup, a
  // microphone that never worked, a tab closed on the first question.
  //
  // Short on purpose. The slot is claimed when the stream opens precisely so an
  // interview of nothing but "could you repeat that" cannot run for forty
  // minutes uncharged; a long refund window would reopen exactly that. Two
  // minutes is enough to discover a broken setup and not enough to be worth
  // abusing, because every new attempt needs a new session and a new plan, and
  // plans spend the daily model budget.
  QUOTA_REFUND_WINDOW_MS: 2 * 60 * 1000,
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
  // Largest WebSocket message the server will accept at all. `ws` defaults to
  // 100 MiB, and MAX_QUEUED_AUDIO_FRAMES bounds frames by COUNT, not size — so
  // without this one authenticated candidate could queue 200 x 100 MiB and take
  // the task, and every other live interview on it, down. A message over this
  // closes the socket with 1009.
  //
  // Under Node `ws` enforces it before buffering. Under Bun it does NOT: Bun's
  // `ws` shim ignores `maxPayload` (measured), so routes/interview.ts checks it
  // again in the message handler, and Bun's own ~16 MiB limit is the only thing
  // that stops a message before it is buffered.
  MAX_SOCKET_MESSAGE_BYTES: 16 * 1024,
  // Largest single audio frame forwarded to Sonic. The browser's worklet sends
  // 512 samples of 16-bit PCM — 1,024 bytes — per frame (apps/web
  // audioConstants.ts). Eight times that is headroom for a client that batches,
  // and small enough that the queue's worst case is 200 x 8 KiB = 1.6 MiB.
  MAX_AUDIO_FRAME_BYTES: 8 * 1024,
  // Text frames carry one control word today ("stop"). Anything longer is not a
  // message this server understands, and is dropped without being decoded.
  MAX_CONTROL_MESSAGE_BYTES: 64,
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

export const WORKER = {
  // One receive can return up to 10. Kept at the cap because they are processed
  // sequentially anyway, and fewer receive calls is fewer billed requests.
  RECEIVE_BATCH_SIZE: 10,
  // SQS's long-poll maximum. Without it an idle worker bills a request every
  // few milliseconds and gets nothing back for each one.
  LONG_POLL_SECONDS: 20,
  // Must comfortably exceed one Bedrock call plus its writes, or the message is
  // redelivered while the first attempt is still running — and that duplicate
  // pays for a second generation. Ministral answers in well under a second;
  // this leaves room for a slow one without leaving a failed message invisible
  // for minutes.
  VISIBILITY_TIMEOUT_SECONDS: 120,
} as const;

export const SQS = {
  // SendMessageBatch's hard cap. Not a tuning value — sending 11 is a
  // validation error, not a slower request. Same shape as BatchWriteItem's 25
  // in lib/sessions.ts.
  SEND_BATCH_SIZE: 10,
} as const;

// The reasons `shutdown()` is called with in routes/interview.ts.
//
// Named here rather than left inline because they are now read as well as
// written: they used to reach only a log line, where a typo cost nothing, and
// they are now mapped to the stored `endReason` that says whether a candidate sat
// an interview or closed the tab. A string that drifts on one side of that
// mapping silently reclassifies every session ending that way.
//
// The Sonic stream can also close for reasons of its own — an idle timeout, a
// stream error — which arrive as strings that are not in this list. `endReasonOf`
// buckets those rather than guessing; see its comment.
export const INTERVIEW_CLOSE = {
  INTERVIEWER_ENDED: "interview complete",
  TIME_LIMIT: "time limit reached",
  CANDIDATE_ENDED: "candidate ended interview",
  DISCONNECTED: "client disconnected",
  SOCKET_ERROR: "socket error",
  STARTUP_FAILED: "startup failed",
} as const;

// CloudWatch metric names and dimensions.
//
// Named here rather than inlined because three things have to agree on every one
// of these strings and they live in three places: the emitter in lib/metrics.ts,
// the reader in routes/adminMetrics.ts, and the alarms in
// infra/terraform/modules/cloudwatch. A typo in any one of them does not fail —
// it produces an empty series or an alarm stuck in INSUFFICIENT_DATA, which looks
// exactly like "nothing has happened yet".
//
// **Dimension design is a cost decision, not a modelling one.** Every distinct
// combination of namespace + metric name + dimension values is a separate custom
// metric billed monthly. That makes some obvious-looking dimensions actively
// dangerous:
//
//   - A `StatusCode` dimension would create one metric per (route, status) pair
//     and grow every time a route learns a new failure mode. 4xx and 5xx are
//     separate metric NAMES here instead, which is a flat two rather than a
//     multiplier.
//   - A `UserId` dimension would create one metric per user, forever, including
//     for deleted accounts. Per-user numbers come from DynamoDB session records,
//     which is where they are exact and free.
//   - An un-bucketed request path would be unbounded and attacker-controlled —
//     `GET /<random>` on a 404 would mint a metric per request. See
//     `UNMATCHED_ROUTE` below, which is the guard against exactly that.
export const METRICS = {
  // The only dimension carried by every metric. One value per environment, so the
  // aggregate series stay cheap and dev never pollutes prod's alarms.
  DIMENSION_ENVIRONMENT: "Environment",
  // Added only to the per-request metrics, and only ever a matched route
  // TEMPLATE (`/api/v1/sessions/:sessionId`), never a real path.
  DIMENSION_ROUTE: "Route",

  // The bucket every request that matched no route falls into.
  //
  // This is the cost guard. Without it the Route dimension takes `req.path`
  // verbatim on a 404, and since that is whatever the caller typed, a loop over
  // random URLs would create an unbounded number of billed metrics — a denial of
  // wallet with no rate limit in front of it, because unmatched paths never reach
  // the authenticated routers the limiter is mounted on.
  UNMATCHED_ROUTE: "unmatched",

  REQUEST_COUNT: "RequestCount",
  REQUEST_LATENCY: "RequestLatency",
  REQUEST_4XX: "Requests4xx",
  REQUEST_5XX: "Requests5xx",

  // Sonic. Carried WITHOUT the Route dimension: the voice loop is one WebSocket
  // upgrade, not a route, and tagging it with a path would imply a breakdown that
  // does not exist.
  //
  // Token counts are the real cost driver on this path and the reason this group
  // exists at all — Sonic bills by open stream duration and by tokens, and
  // neither is visible in a latency graph.
  SONIC_STREAM_LATENCY: "SonicStreamLatency",
  SONIC_STREAM_DURATION: "SonicStreamDuration",
  SONIC_INPUT_TOKENS: "SonicInputTokens",
  SONIC_OUTPUT_TOKENS: "SonicOutputTokens",
  SONIC_STREAM_ERRORS: "SonicStreamErrors",
  SONIC_STREAM_RENEWALS: "SonicStreamRenewals",

  INTERVIEW_SESSIONS_STARTED: "InterviewSessionsStarted",
  INTERVIEW_SESSIONS_REFUSED: "InterviewSessionsRefused",

  // Security signals, Environment dimension only (one metric each, not one per
  // route or per user). Alarmed on in infra/terraform/modules/cloudwatch.
  //   AuthFailures   every 401 from AuthMiddleware and every refused WebSocket
  //                  handshake. A spike is token stuffing or a broken client.
  //   AdminRefusals  every request RequireAdmin turns away with its 404. Any
  //                  sustained count is someone probing the admin surface.
  AUTH_FAILURES: "AuthFailures",
  ADMIN_REFUSALS: "AdminRefusals",

  // EMF's documented ceiling on metric definitions in one log event. Nothing here
  // approaches it — the largest emission is four values — but the emitter refuses
  // rather than writing an event CloudWatch would silently drop whole.
  MAX_METRICS_PER_EVENT: 100,
  // EMF dimension-value limit. A longer value invalidates the whole event, so an
  // over-long route template is truncated rather than allowed to discard the
  // metrics it was attached to.
  MAX_DIMENSION_VALUE_CHARS: 255,
} as const;

export const SECONDS_PER_DAY = 24 * 60 * 60;

// How long a session's items live before DynamoDB removes them.
//
// Only takes effect where the table has TTL enabled on `expiresAt` — dev does,
// prod does not. Six months is long enough that a candidate can revisit a past
// interview across a job search, and short enough that storage and the privacy
// surface both stay bounded.
//
// TTL deletion is best-effort and can lag by up to 48 hours, which is fine for
// retention and would not be fine for erasure. That is why the two are separate
// mechanisms rather than one.
export const SESSION_RETENTION = {
  DAYS: 180,
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

// Cookie-based auth (ADR-0011). See lib/authCookies.ts for how these are used.
export const AUTH = {
  // Mount point of the auth router. The refresh, pending-TOTP and OAuth cookies
  // are scoped under it so the browser never attaches them to any other route
  // or to the interview WebSocket.
  ROUTE_PREFIX: "/api/v1/auth",
  // Lifetimes match the Cognito client's token validity: 1 hour and 7 days.
  // A cookie outliving its token would only ever carry a rejected value.
  ACCESS_COOKIE_MAX_AGE_MS: 60 * 60 * 1000,
  REFRESH_COOKIE_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  // Cognito's own session for a challenge lasts 3 minutes.
  PENDING_TOTP_MAX_AGE_MS: 3 * 60 * 1000,
  // Long enough to sit through Google's consent screen.
  OAUTH_STATE_MAX_AGE_MS: 10 * 60 * 1000,
  // Bytes of randomness in the OAuth state and the PKCE verifier.
  OAUTH_RANDOM_BYTES: 32,
  // Cognito prefixes a federated user's username with the provider name.
  GOOGLE_USERNAME_PREFIX: "google_",
  OAUTH_SCOPES: "openid email profile aws.cognito.signin.user.admin",
  // Shown as the account's issuer in an authenticator app.
  TOTP_ISSUER: "PrepPilot",
  // The pre sign-up Lambda refuses a failed human check and a refused address
  // under one exception name; its message tells them apart. MUST stay in step
  // with TURNSTILE_REFUSAL in infra/terraform/modules/cognito/pre_sign_up/index.mjs.
  HUMAN_CHECK_REFUSAL_MARKER: "confirm you are a person",
  // A token-endpoint call that takes longer is a stalled socket.
  TOKEN_ENDPOINT_TIMEOUT_MS: 10_000,
} as const;
