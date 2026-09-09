# Data Model

**Status:** partly implemented. The DynamoDB table and both S3 buckets exist on
`dev` and are in use. **Redis does not exist and never will** — ElastiCache was
dropped during Phase 3, so every mention of it below this line is stale and is
kept only until this document is rewritten. [ADR-0003](../adr/0003-redis-hot-state-dynamodb-durable.md)
is likewise still marked Accepted and needs superseding.

Two stores: DynamoDB for anything that must survive, S3 for bytes. Interview
audio is **not** stored at all — it streams through the WebSocket and is
discarded, and the transcript in DynamoDB is the durable record.

---

## 1. DynamoDB

Single table, on-demand capacity. Table name comes from SSM at boot — never
hardcoded, and never derived from `NODE_ENV`.

### Key schema

| Attribute | Type   | Role         |
| --------- | ------ | ------------ |
| `PK`      | String | Partition key |
| `SK`      | String | Sort key      |

### Item types, and who is responsible for each

Every row has three owners: something that **writes** it, something that
**deletes** it on an erasure request, and — for session data — a **TTL** that
expires it on its own. A blank cell in either of the last two columns is a leak,
not an omission.

| PK | SK | `type` | Written by | Deleted by | TTL |
| --- | --- | --- | --- | --- | --- |
| `SESSION#<sid>` | `META` | `session_meta` | `createSession` | `deleteSessionData` | ✅ |
| `SESSION#<sid>` | `INPUTS` | `session_inputs` | `createSession` | `deleteSessionData` | ✅ |
| `SESSION#<sid>` | `ANSWER#<qId>` | `session_answer` | `recordAnswer` | `deleteSessionData` | ✅ |
| `SESSION#<sid>` | `EVAL#<qId>` | `session_evaluation` | Evaluator worker *(P5)* | `deleteSessionData` | ✅ |
| `SESSION#<sid>` | `SUMMARY` | `session_eval_summary` | Evaluator worker *(P5)* | `deleteSessionData` | ✅ |
| `SESSION#<sid>` | `COACH` | `session_coach` | Coach agent *(P6)* | `deleteSessionData` | ✅ |
| `USER#<uid>` | `SESSION#<sid>` | `user_session_ref` | `createSession` | **`deleteUserSessionRefs`** | ✅ |
| `USER#<uid>` | `PROFILE` | `user_profile` | `saveProfileDetails`, `saveResumeAndRepos` | `deleteProfileItems` | ❌ |
| `USER#<uid>` | `PLAN` | `cached_plan` | `putCachedPlan` | `deleteProfileItems` | ❌ |

**The bolded row is why this table exists.** `USER#<uid>/SESSION#<sid>` refs live
in the *user's* partition while describing a *session*, so `deleteSessionData`
never saw them and `deleteProfileItems` did not own them. They survived every
erasure — invisibly, because nothing reads a ref whose session is gone. That is
the shape of every bug this table is meant to prevent: a denormalised copy with
a writer and no deleter.

`PROFILE` and `PLAN` carry no TTL on purpose. They are the account, not a
session artefact, and an account that quietly evaporates after a few quiet
months is a bug rather than a retention policy. They go only when erasure
removes them.

**`SUMMARY`, not `EVAL#SUMMARY`.** The rollup sat under the `EVAL#` prefix until
it was moved, which put it inside the range `Query ... begins_with("EVAL#")`
returns. That query is how completion is derived, so the rollup would have
counted as an evaluation and fired the Coach one question early.

`sid` and `qId` are ULIDs, not UUIDs. ULIDs sort lexicographically by creation
time, so `ANSWER#<qId>` items come back from a Query in the order they were
asked — no separate sequence attribute, no client-side sort.

### Querying `USER#<uid>`

That partition now holds three item types. `PLAN` and `PROFILE` both sort before
`SESSION#`, so **a history query must filter `begins_with(SK, "SESSION#")`** — an
unfiltered Query returns the profile first and fails to parse it as a session
ref.

### Retention

Session items carry `expiresAt`, a Unix-epoch second set by `sessionExpiresAt()`
and shared by every item in one session so its parts cannot expire at different
moments. Whether it is honoured is per-environment: `dev` enables TTL on that
attribute, `prod` deliberately does not.

TTL deletion is best-effort and can lag by up to 48 hours. That is fine for
retention and is not fine for an erasure request, which is why the two are
separate mechanisms rather than one.

### Item shapes

**`SESSION#<sid> / META`**

```
sessionId        string   ULID
userId           string   Cognito sub
status           string   planning | ready | in_progress | evaluating | complete | failed
createdAt        string   ISO 8601
role             string   target role the interview is pitched at
plan             map      Planner output: question mix, difficulty, focus areas
questionCount    number   total planned questions — the denominator for completion
resumeKey        string   S3 key
githubUsername   string
```

**`SESSION#<sid> / INPUTS`**

```
repos            list     scraped GitHub repositories, capped at MAX_REPOS
resumeText       string   extracted text, truncated to MAX_RESUME_CHARS
resumeKey        string   S3 key the text was parsed from
```

Written once by `POST /pre-interview`, read once by `POST /plan`, never updated.

It exists for two reasons. The security one: `POST /plan` used to accept `repos`
and `resumeText` in its request body, which let any caller plan against
repositories or a resume that were not theirs — the server had no way to tell.
Reading them from the session closes that, and it is why the plan endpoint's
body is now just `{ sessionId, targetRole }`.

The cost one is why this is a separate item rather than attributes on `META`.
DynamoDB bills an update against the whole item's size, not the delta. This is
roughly 10 KB, and `META` takes four status updates across a session's life, so
folding it in would cost about 40 WCU instead of 4 — on the one item the
interview loop reads repeatedly. Same reasoning as the per-answer transcript
split below.

The alternative considered was re-parsing the PDF from S3 at plan time, which
keeps storage smaller but puts an S3 GET and a PDF parse on a path the candidate
is waiting on.

**`SESSION#<sid> / ANSWER#<qId>`**

```
questionId       string   ULID
questionText     string   from Sonic textOutput, role: ASSISTANT
questionType     string   behavioural | technical | role_specific
askedAt          string   ISO 8601
transcript       string   from Sonic textOutput, role: USER — final only, not partials
durationMs       number
interrupted      boolean  candidate barged in over the question
```

Both text fields come from the same Sonic `textOutput` event stream,
distinguished by `role`. They are transcripts of audio that was already spoken,
not the source of it — never treat `questionText` as canonical before the
corresponding audio has finished streaming.

`interrupted` exists because barge-in is now possible. An answer given over a
half-delivered question is not comparable to one given after the full question,
and the Evaluator needs to know which it is looking at.

**`SESSION#<sid> / EVAL#<qId>`**

```
questionId       string
correctness      number   0–10
clarity          number   0–10
depth            number   0–10
rationale        string   why those scores
modelId          string   which Bedrock model produced this
evaluatedAt      string   ISO 8601
```

Recording `modelId` matters: when the primary model is unavailable and a
request falls back to Mistral, scores from the two aren't strictly comparable.
Without this attribute that's invisible forever. This applies to the Evaluator's
text model only — the interview itself has no fallback, since Nova 2 Sonic is
the sole speech model in the stack.

**`SESSION#<sid> / SUMMARY`**

```
questionCount    number   copied from META at enqueue time
averages         map      mean per dimension, written when complete
```

No `completedCount`. `ADD completedCount 1` is not idempotent and SQS is
at-least-once, so a redelivered message over-counts and the Coach fires early.
Completion is derived from `Query ... begins_with("EVAL#")` instead, which is
exact by construction — and is exactly why this item must not sit under that
prefix.

**`SESSION#<sid> / COACH`**

```
plan             list     ordered improvement items
citations        list     Knowledge Base source references
generatedAt      string   ISO 8601
```

### Access patterns

| # | Need                        | Operation                                            |
| - | --------------------------- | ---------------------------------------------------- |
| 1 | Whole session               | `Query PK = SESSION#<sid>`                            |
| 2 | Session metadata only       | `GetItem PK = SESSION#<sid>, SK = META`               |
| 2b| Owner + Planner inputs      | `BatchGetItem` on `SK = META` and `SK = INPUTS`       |
| 3 | Transcript in order         | `Query PK = SESSION#<sid>, SK begins_with ANSWER#`    |
| 4 | All evaluations             | `Query PK = SESSION#<sid>, SK begins_with EVAL#`      |
| 5 | User's session history      | `Query PK = USER#<uid>, SK begins_with SESSION#`      |
| 6 | Completion progress         | count of pattern 4 — see below                        |
| 7 | Score rollup                | `GetItem PK = SESSION#<sid>, SK = SUMMARY`            |
| 8 | Candidate profile           | `GetItem PK = USER#<uid>, SK = PROFILE`               |
| 9 | Cached plan                 | `GetItem PK = USER#<uid>, SK = PLAN`                  |

### The GSI in overview §6 is not needed

`overview.md` mentions a GSI on `SK` for user history. With the
`USER#<uid> / SESSION#<sid>` lookup item present, pattern 5 is a plain base-table
Query — the GSI is redundant. An inverted index would only help for
"given a session, find its user", and that's already an attribute on `META`.

Recommendation: **don't create the GSI.** It's a second write on every session
create, extra cost, and one more thing to keep consistent, for an access
pattern nothing has. Add it later if a real query needs it. This document is
correct on this point; `overview.md` §6 predates the analysis.

### Consistency and idempotency

- Evaluations are written with `PutItem` keyed by `questionId`. SQS is
  at-least-once, so a redelivered message overwrites the same item rather than
  creating a duplicate.
- **There is no `completedCount`.** `ADD completedCount 1` is not idempotent
  and a redelivery over-counts, firing the Coach early. Completion is derived
  from `Query ... begins_with("EVAL#")`, which is exact by construction — and is
  why the rollup lives at `SUMMARY` rather than under that prefix. The counter
  exists in
  [ADR-0004](../adr/0004-sqs-fargate-spot-async-evaluation.md) as the original
  design.
- Reads for user-facing display can be eventually consistent. The completion
  check that triggers the Coach agent must use a strongly consistent read, or
  it can fire early.
- Transcript writes happen mid-stream, not at turn end. Sonic emits `textOutput`
  events as speech is recognised, so persist only events marked final and let
  partials stay in Redis. Writing every partial would multiply DynamoDB writes
  by an order of magnitude for data that is immediately superseded.

### Size limits

DynamoDB items cap at 400 KB. Per-answer items are comfortably under that — a
long spoken answer transcribes to a few KB. This is the main reason the
transcript is split per answer rather than accumulated into `META`: a
30-question session in one item would approach the limit and rewrite the whole
thing on every turn.

### TTL

No TTL on session data — it's the product. If dev-environment cleanup is
wanted, add a TTL attribute in `dev` only, never in `prod`.

---

## 2. Redis

```
session:<sid>:state       JSON blob of live interview state    TTL 2h
ratelimit:<uid>:<minute>  INCR counter                          TTL 60s
lock:session:<sid>        SET NX, single-consumer guard         TTL 30s
```

`session:<sid>:state` holds: current question index, turn count, WebSocket
connection id, in-flight partial transcripts, and the Sonic stream's prompt and
content identifiers. All of it is rebuildable from DynamoDB except the stream
identifiers, which are meaningless after the stream closes anyway.

Rules:

- Nothing in Redis is a source of truth. If losing a value would break the
  product, it goes to DynamoDB first and Redis second.
- Every key has a TTL. A key without one is a leak.
- Redis unavailability degrades the interview, it doesn't end it — rebuild
  state from DynamoDB and continue.
- Rate limiting is keyed by Cognito `sub`, not IP. Per-IP limits punish shared
  networks and don't map to the cost being controlled, which is per-user
  Bedrock spend.
- Session wall-clock start time lives here and is checked on every turn. Sonic
  bills by open stream duration, so an unbounded session is an unbounded bill.

---

## 3. S3

```
resumes/<uid>/<sid>.pdf         uploaded resume
audio/<sid>/<qId>.pcm           per-answer audio, 16 kHz 16-bit PCM mono
frontend/                       static assets served via CloudFront
```

Audio is raw PCM rather than WebM. That is what the `AudioWorklet` captures and
what Sonic consumes, so persisting it is a passthrough write of frames already
on the wire — no transcoding step, no `MediaRecorder`. The tradeoff is size:
PCM is roughly ten times larger than Opus for the same audio, and it will not
play in a browser without a WAV header prepended. If playback in the results UI
matters, write `.wav` instead and accept the 44-byte header.

Two buckets, not one: a private bucket for `resumes/` and `audio/`, and a
public-read-via-CloudFront bucket for `frontend/`. Putting user uploads in the
same bucket as CDN-served assets is one misconfigured policy away from a
disclosure.

- Uploads use presigned PUT URLs — the browser writes directly to S3 rather
  than proxying multipart through Express.
- Presigned URLs expire in 5 minutes and are scoped to the exact key.
- The key embeds `<uid>`, and the backend generates it from the verified JWT
  claim — never from a client-supplied value.
- Block Public Access on the private bucket, SSE-S3 at minimum, versioning off
  (these are disposable inputs, not records).
- **Interview audio is never stored.** It streams through the WebSocket and is
  discarded; the DynamoDB transcript is the durable record and the only thing
  the Evaluator and Coach read. There is no `audio/` prefix, no `audioKey`
  attribute and no lifecycle rule for either.
- One resume object per user at `resumes/<uid>/resume.pdf`, overwritten on
  re-upload. The stored PDF keeps its PII deliberately — redaction protects the
  model boundary, and the redacted text lives on the profile item. The stable
  key is also what makes erasure a single `DeleteObject` with no `ListBucket`.

---

## 4. Schema ownership

Every shape above gets a Zod schema, and the TypeScript types are inferred with
`z.infer<>` rather than hand-written alongside. Those schemas are the contract
between the API layer and the storage layer, and between backend and frontend.

They belong in `packages/shared` — which does not exist yet. Until it does,
they live in the backend and get moved wholesale, not copied.

Validate on the way **out** of DynamoDB as well as in. An item written by an
older deploy may not match the current schema, and a parse failure at the
boundary is a better outcome than an `undefined` surfacing three layers up.

---

## Related

- [`overview.md`](./overview.md) — system architecture
- [`api.md`](./api.md) — endpoint and WebSocket contracts
- [ADR-0003](../adr/0003-redis-hot-state-dynamodb-durable.md) — store split
- [ADR-0004](../adr/0004-sqs-fargate-spot-async-evaluation.md) — async evaluation
- [ADR-0005](../adr/0005_nova_sonic_speech_to_speech.md) — voice loop