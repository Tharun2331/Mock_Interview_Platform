# API Contract

**Status:** design, except where marked built.

Base path `/api/v1`. Every response is JSON except the WebSocket upgrade and
Polly audio.

---

## 1. What exists today

One route, on `main`:

```
POST /api/v1/pre-interview
  body:     { gitHub: string }
  200:      { repos: Array<{ description, name, fullName, starCount }> }
  411:      { message: "Incorrect body" }     ← should be 400
  500:      { message: "Failed to fetch GitHub repos" }
```

It has no auth, no rate limit, returns the wrong status code on validation
failure, and types the GitHub response as `any`. It is superseded by
`POST /api/v1/sessions` below and should be removed rather than extended.

Everything else in this document is unbuilt.

---

## 2. Conventions

**Auth.** Every route except `/health` requires
`Authorization: Bearer <cognito-jwt>`. The `requireAuth` middleware verifies
the token against Cognito's JWKS (cached in memory) and attaches the verified
`sub` to the request. **Never trust a user id from a request body or path
parameter** — always the token claim.

**Validation.** Every body, query, and path parameter is parsed with a Zod
schema before the handler runs. Parse failure is `400`, never `411` or `422`.

**Errors.** One envelope everywhere:

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "Human-readable, safe to display",
    "requestId": "01J..."
  }
}
```

`code` is a stable enum the frontend can branch on. `message` is for humans and
may change. Never leak an AWS SDK error message to the client — log it with the
`requestId` and return a mapped code.

**Status codes.** `400` validation · `401` missing or invalid token · `403`
authenticated but not the owner · `404` not found · `409` state conflict (e.g.
starting an interview that's already complete) · `429` rate limited · `500`
unexpected · `503` upstream AWS unavailable.

**Ownership.** Every session route checks that `META.userId` matches the token
`sub` and returns `404` — not `403` — when it doesn't. `403` confirms the
session exists, which is an enumeration oracle.

**Idempotency.** `POST /sessions` accepts an optional `Idempotency-Key` header.
A retry with the same key returns the original session rather than creating a
second one.

---

## 3. HTTP routes

### `GET /health`

Unauthenticated. Returns `200` with `{ status: "ok" }`. Used by the ALB target
group health check — keep it cheap and don't have it touch DynamoDB or Redis,
or a cache blip will drain your targets.

---

### `POST /api/v1/uploads/resume`

Returns a presigned PUT URL for the client to upload directly to S3.

```
body:  { contentType: "application/pdf", sizeBytes: number }
201:   { uploadUrl: string, key: string, expiresAt: string }
400:   content type not PDF, or size over limit
```

The key is generated server-side from the verified `sub`. `sizeBytes` is
checked against a cap before signing — the presigned URL enforces it via
content-length-range so an oversized upload fails at S3, not after.

---

### `POST /api/v1/sessions`

Creates a session and runs the Planner agent. Replaces `/pre-interview`.

```
body:  { resumeKey: string, githubUsername: string, role: string }
202:   { sessionId: string, status: "planning" }
400:   validation failure
409:   resumeKey does not belong to the caller
```

Returns `202`, not `201`: planning involves resume parsing, a GitHub fetch, and
a Bedrock call. Doing that inside the request would put a multi-second wait in
front of the user with nothing to show. The client polls `GET /sessions/:id`
until `status` becomes `ready`.

---

### `GET /api/v1/sessions/:sessionId`

```
200:   { sessionId, status, role, createdAt, questionCount, plan? }
404:   not found, or not owned by caller
```

`plan` is present once `status` is `ready`.

---

### `GET /api/v1/sessions`

```
query: { limit?: number (default 20, max 50), cursor?: string }
200:   { sessions: SessionSummary[], nextCursor: string | null }
```

Cursor pagination over the `USER#<uid>` partition. Opaque cursor — base64 of
the DynamoDB `LastEvaluatedKey`, never a raw offset.

---

### `POST /api/v1/sessions/:sessionId/complete`

Ends the round and enqueues evaluation.

```
202:   { status: "evaluating", queued: number }
409:   session is not in_progress
```

Enqueues one SQS message per answered question. Returning `202` with a count
lets the client show real progress rather than a spinner of unknown duration.

---

### `GET /api/v1/sessions/:sessionId/evaluation`

```
200:   { status: "evaluating" | "complete",
         completed: number, total: number,
         evaluations: Evaluation[] }
```

Poll target while the worker drains the queue. Returns partial results as they
land — a candidate can read the first three scores while the rest process.

---

### `GET /api/v1/sessions/:sessionId/coach`

```
200:   { plan: CoachItem[], citations: Citation[], generatedAt: string }
404:   evaluation not complete yet
409:   coach generation in progress
```

---

## 4. WebSocket: the interview loop

```
WSS /api/v1/sessions/:sessionId/interview
```

Auth happens once, at the handshake, via a short-lived ticket rather than a
header — browser `WebSocket` cannot set `Authorization`. The client calls
`POST /api/v1/sessions/:sessionId/ticket` (200, `{ ticket, expiresIn: 60 }`),
then connects with `?ticket=<value>`. The ticket is single-use, held in Redis,
and deleted on connect.

Passing the JWT itself as a query parameter would put a long-lived credential
into ALB access logs and browser history. The ticket expires in 60 seconds and
is worthless once used.

### Message envelope

Both directions use a discriminated union on `type`, parsed with Zod. Unknown
types are logged and ignored, never thrown on — a client on an older deploy
shouldn't kill the connection.

### Client → server

| `type`         | Payload                          | Meaning                        |
| -------------- | -------------------------------- | ------------------------------ |
| `audio.chunk`  | binary frame                     | Raw PCM from MediaRecorder     |
| `turn.end`     | `{}`                             | Candidate finished speaking    |
| `turn.skip`    | `{}`                             | Skip this question             |
| `session.end`  | `{}`                             | End the interview early        |
| `ping`         | `{}`                             | Keepalive                      |

Audio arrives as binary frames, not base64 in JSON — base64 costs a third more
bytes and forces a decode per chunk inside the latency budget.

### Server → client

| `type`               | Payload                                   | Meaning                       |
| -------------------- | ----------------------------------------- | ----------------------------- |
| `transcript.partial` | `{ text }`                                 | Revisable, display only        |
| `transcript.final`   | `{ questionId, text }`                     | Persisted, sent to Bedrock     |
| `question.chunk`     | `{ text }`                                 | Streamed Bedrock token span    |
| `question.complete`  | `{ questionId, text, index, total }`       | Full question text            |
| `audio.chunk`        | binary frame                               | Polly output                   |
| `audio.complete`     | `{ questionId }`                           | Playback can finish            |
| `session.complete`   | `{ sessionId }`                            | No questions remain            |
| `error`              | `{ code, message, fatal: boolean }`        | Fatal implies close follows    |
| `pong`               | `{}`                                       | Keepalive response             |

`question.chunk` and `audio.chunk` interleave deliberately: Polly synthesis
starts on the first complete sentence rather than waiting for the full Bedrock
generation. That overlap is most of the 1.6–2.0s turn budget.

### Connection lifecycle

- **Idle timeout.** A candidate thinking produces no frames. The ALB idle
  timeout defaults to 60 seconds and **must be raised** — see
  [ADR-0002](../adr/0002-alb-not-api-gateway.md). Client `ping` every 30s is a
  second line of defence, not a substitute.
- **Reconnect.** Session state lives in Redis, so a reconnect resumes at the
  current question. The Transcribe stream does not resume — it restarts, and
  any partial transcript in flight is lost. Re-ask rather than pretending
  continuity.
- **Cleanup.** On close, the server must end the Transcribe stream. A leaked
  stream bills per minute for as long as it stays open. This is the single
  easiest way to get a surprising Transcribe bill.
- **One connection per session.** A second connect for the same `sessionId`
  closes the first with `code: SESSION_TAKEOVER`.

---

## 5. Rate limits

Per Cognito `sub`, enforced in Redis, returned as `429` with `Retry-After`.

| Scope                    | Limit          | Why                              |
| ------------------------ | -------------- | -------------------------------- |
| `POST /sessions`         | 5 / hour       | Each runs a Bedrock planning call |
| WebSocket connects       | 10 / hour      | Each opens a Transcribe stream    |
| Interview turns          | 60 / session   | Caps runaway loop cost            |
| All routes               | 100 / minute   | General abuse floor               |

These are cost controls first and abuse controls second. A bug that reconnects
in a loop can run up real Bedrock and Transcribe spend in minutes, and nothing
else in the system will notice.

---

## 6. What is deliberately not exposed

The original route sketch had `/chat`, `/speak`, `/evaluate`, `/plan`, and
`/coach` — one endpoint per agent. Those are gone. Agents are internal
functions, not a public surface: exposing `/speak` means anyone with a token
can bill arbitrary Polly synthesis, and exposing `/chat` gives away raw Bedrock
access wrapped in your credentials.

Routes are organised around session resources instead. The agent that services
a request is an implementation detail.

`POST /transcribe` is absent for a different reason — it could not have worked.
See [ADR-0001](../adr/0001-websocket-transport-for-transcribe.md).

---

## Related

- [`overview.md`](./overview.md) — system architecture
- [`data-model.md`](./data-model.md) — persisted shapes
- [ADR-0001](../adr/0001-websocket-transport-for-transcribe.md) — transport
- [ADR-0002](../adr/0002-alb-not-api-gateway.md) — ALB and idle timeout