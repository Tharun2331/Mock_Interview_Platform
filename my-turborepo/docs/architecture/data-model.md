# Data Model

**Status:** design · Nothing in this document is implemented yet. No DynamoDB
table, Redis cluster, or S3 bucket exists on `main` or `dev`.

Three stores, split by lifetime: DynamoDB for anything that must survive,
Redis for anything that must be fast and may be lost, S3 for bytes. See
[ADR-0003](../adr/0003-redis-hot-state-dynamodb-durable.md) for why.

---

## 1. DynamoDB

Single table, on-demand capacity. Table name comes from SSM at boot — never
hardcoded, and never derived from `NODE_ENV`.

### Key schema

| Attribute | Type   | Role         |
| --------- | ------ | ------------ |
| `PK`      | String | Partition key |
| `SK`      | String | Sort key      |

### Item types

```
PK                   SK                Purpose
─────────────────────────────────────────────────────────────────────
SESSION#<sid>        META              session metadata + interview plan
SESSION#<sid>        ANSWER#<qId>      question text + candidate transcript
SESSION#<sid>        EVAL#<qId>        per-answer scores + rationale
SESSION#<sid>        EVAL#SUMMARY      rollup + completion counter
SESSION#<sid>        COACH             improvement plan
USER#<uid>           SESSION#<sid>     user → session lookup
```

`sid` and `qId` are ULIDs, not UUIDs. ULIDs sort lexicographically by creation
time, so `ANSWER#<qId>` items come back from a Query in the order they were
asked — no separate sequence attribute, no client-side sort.

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

**`SESSION#<sid> / ANSWER#<qId>`**

```
questionId       string   ULID
questionText     string
questionType     string   behavioural | technical | role_specific
askedAt          string   ISO 8601
transcript       string   final Transcribe output, not partials
audioKey         string   S3 key, nullable — audio persistence is best-effort
durationMs       number
```

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
Without this attribute that's invisible forever.

**`SESSION#<sid> / EVAL#SUMMARY`**

```
completedCount   number   incremented as each evaluation lands
questionCount    number   copied from META at enqueue time
averages         map      mean per dimension, written when complete
```

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
| 3 | Transcript in order         | `Query PK = SESSION#<sid>, SK begins_with ANSWER#`    |
| 4 | All evaluations             | `Query PK = SESSION#<sid>, SK begins_with EVAL#`      |
| 5 | User's session history      | `Query PK = USER#<uid>, SK begins_with SESSION#`      |
| 6 | Completion progress         | `GetItem PK = SESSION#<sid>, SK = EVAL#SUMMARY`       |

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
- `EVAL#SUMMARY.completedCount` is the exception — `ADD completedCount 1` is
  not idempotent and a redelivery over-counts. Either guard it with a
  conditional write on the `EVAL#<qId>` item not already existing, or drop the
  counter and derive completion from `Query ... begins_with EVAL#`. Deriving is
  simpler and this document prefers it; the counter exists in
  [ADR-0004](../adr/0004-sqs-fargate-spot-async-evaluation.md) as the original
  design.
- Reads for user-facing display can be eventually consistent. The completion
  check that triggers the Coach agent must use a strongly consistent read, or
  it can fire early.

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
connection id, and the last few turns of conversation context for Bedrock. All
of it is rebuildable from DynamoDB.

Rules:

- Nothing in Redis is a source of truth. If losing a value would break the
  product, it goes to DynamoDB first and Redis second.
- Every key has a TTL. A key without one is a leak.
- Redis unavailability degrades the interview, it doesn't end it — rebuild
  state from DynamoDB and continue.
- Rate limiting is keyed by Cognito `sub`, not IP. Per-IP limits punish shared
  networks and don't map to the cost being controlled, which is per-user
  Bedrock spend.

---

## 3. S3

```
resumes/<uid>/<sid>.pdf         uploaded resume
audio/<sid>/<qId>.webm          per-answer audio
frontend/                       static assets served via CloudFront
```

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
- Audio persistence is best-effort. A failed audio upload does not fail the
  interview turn; `audioKey` is nullable for exactly this reason.

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