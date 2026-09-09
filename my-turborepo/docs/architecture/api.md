# API Contract

**Status:** design, except where marked built.

Base path `/api/v1`. Every response is JSON except the WebSocket upgrade and
streamed audio frames.

---

## 1. What exists today

On `dev`. Every route below `/api/v1` is behind Cognito JWT verification and
the per-user rate limiter.

```
GET    /api/v1/profile              -> { profile: ProfileView | null }
PUT    /api/v1/profile              { username, firstName, lastName }
POST   /api/v1/profile/resume       multipart: resume (PDF), gitHub?
                                    -> { profile, resume: { characters, pages,
                                         usable, redactedCount, redactedTypes } }
PUT    /api/v1/profile/github       { gitHub? }   omit to disconnect
DELETE /api/v1/profile              204, erases the account

POST   /api/v1/pre-interview        no body; mints a session from the profile
                                    -> { sessionId }
POST   /api/v1/plan                 { sessionId, targetRole } -> PlanResponse

WS     /            access token in the WebSocket subprotocol, verified during
                    the HTTP upgrade
```

`GET /profile` answers `{ profile: null }` rather than 404 for a candidate who
has never saved one — that is the expected first-sign-in state and what the
onboarding guard asks for, not an error.

`POST /pre-interview` is now a misnomer: it uploads nothing. Resume ingestion
moved to the profile in
[ADR-0007](../adr/0007-user-scoped-redacted-candidate-material.md), and this
route only creates a session and snapshots the profile's material into it.

**Sections 3 and 4 below are a design target, not a description.** They use a
`/api/v1/sessions` shape that was never built, and several of their routes —
history, evaluation, coach — wait on Phases 5 and 6. Where the two disagree,
this section is the one that matches the code.

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

> **Design target, not current state.** These use a `/api/v1/sessions` shape
> that was never built; §1 lists what actually exists. Kept because the response
> shapes and status-code choices below are still the intended destination, and
> because several routes here wait on Phases 5 and 6.


### `GET /health`

Unauthenticated. Returns `200` with `{ status: "ok" }`. Used by the ALB target
group health check — keep it cheap and don't have it touch DynamoDB, or a
transient table error will drain your targets.

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
then connects with `?ticket=<value>`. **Not implemented, and the ticket store
it assumed no longer exists** — see
[ADR-0006](../adr/0006-drop-redis-dynamodb-alone.md). The implemented handshake
verifies the access token from the WebSocket subprotocol during the HTTP
upgrade, which is the only point where a handshake can be rejected before a
socket exists.

Passing the JWT itself as a query parameter would put a long-lived credential
into ALB access logs and browser history. The ticket expires in 60 seconds and
is worthless once used.

Behind this socket the server holds **one Amazon Nova 2 Sonic bidirectional
stream per session** — see
[ADR-0005](../adr/0005_nova_sonic_speech_to_speech.md). The socket is a relay:
candidate audio in, model audio and transcripts out. There is no separate
speech-to-text or text-to-speech hop.

### Message envelope

Both directions use a discriminated union on `type`, parsed with Zod. Unknown
types are logged and ignored, never thrown on — a client on an older deploy
shouldn't kill the connection.

### Client → server

| `type`         | Payload      | Meaning                                                          |
| -------------- | ------------ | ---------------------------------------------------------------- |
| `audio.chunk`  | binary frame | 16 kHz 16-bit PCM mono, from an `AudioWorklet`                    |
| `turn.end`     | `{}`         | Explicit "I'm done" override; Sonic detects turn end on its own   |
| `turn.skip`    | `{}`         | Skip this question                                                |
| `session.end`  | `{}`         | End the interview early                                           |
| `ping`         | `{}`         | Keepalive                                                         |

Audio arrives as binary frames, not base64 in JSON — base64 costs a third more
bytes and forces a decode per chunk inside the latency budget.

**`MediaRecorder` cannot produce this format.** It emits WebM/Opus containers;
Sonic requires raw PCM. Capture goes through an `AudioWorklet` that downsamples
to 16 kHz mono and posts `Int16Array` frames. Any code or doc still referencing
`MediaRecorder` for the interview loop is stale.

`turn.end` is an override, not the mechanism. Sonic performs its own turn
detection, so the client should not gate on a silence timer — send the message
only when the candidate explicitly presses a "done" control.

### Server → client

| `type`               | Payload                             | Meaning                                                     |
| -------------------- | ----------------------------------- | ----------------------------------------------------------- |
| `transcript.partial` | `{ text }`                          | Sonic `textOutput`, `role: USER`, speculative — display only |
| `transcript.final`   | `{ questionId, text }`              | Sonic `textOutput`, `role: USER`, final — persisted          |
| `interviewer.text`   | `{ text }`                          | Sonic `textOutput`, `role: ASSISTANT` — display only         |
| `audio.chunk`        | binary frame                        | Sonic `audioOutput`, 24 kHz LPCM                             |
| `audio.complete`     | `{ questionId }`                    | Playback can finish                                          |
| `turn.interrupted`   | `{ questionId }`                    | Candidate barged in — stop playback, flush the audio buffer  |
| `session.complete`   | `{ sessionId }`                     | No questions remain                                          |
| `error`              | `{ code, message, fatal: boolean }` | Fatal implies close follows                                  |
| `pong`               | `{}`                                | Keepalive response                                           |

Audio and text arrive on the same stream, so there is no synthesis step to
overlap. The turn budget is Sonic's time-to-first-audio-frame rather than a sum
of three hops — measure it before quoting a number.

`interviewer.text` is a transcript of speech the model is already producing.
Never gate playback on it, and never treat it as the canonical question text
before `audio.complete` — the two are independent event streams from one
connection.

`turn.interrupted` has no equivalent in the previous design. Barge-in means the
client can be mid-playback when the candidate starts speaking; the UI must
handle a transition out of `interviewer-speaking` that the user, not the
server, initiated.

### Connection lifecycle

- **Idle timeout.** A candidate thinking produces no frames. The ALB idle
  timeout defaults to 60 seconds and **must be raised** — see
  [ADR-0002](../adr/0002-alb-not-api-gateway.md). Client `ping` every 30s is a
  second line of defence, not a substitute.
- **Reconnect.** Completed exchanges are already in DynamoDB, so nothing said
  is lost. Live turn state is in the task's memory and does not survive, and
  the Sonic stream does not resume — a new stream starts with no conversation
  history. Replay prior turns into the fresh session's context
  or re-ask the question. Don't pretend continuity.
- **Cleanup.** On close, the server must end the Sonic bidirectional stream. An
  open stream bills for as long as it stays open, and a browser tab left open
  with nobody in front of it is the realistic failure mode. This is the single
  easiest way to get a surprising Bedrock bill.
- **One connection per session.** A second connect for the same `sessionId`
  closes the first with `code: SESSION_TAKEOVER`.

---

## 5. Rate limits

Per Cognito `sub`, returned as `429` with `Retry-After`.

**The store is in-memory**, so the budget is per ECS task: at N tasks the
effective limit is `limit x N`. Redis was the intended destination and was
dropped — [ADR-0006](../adr/0006-drop-redis-dynamodb-alone.md) lists the
remaining options. Unresolved; decide before scaling past one task.

| Scope              | Limit        | Why                                    |
| ------------------ | ------------ | -------------------------------------- |
| `POST /sessions`   | 5 / hour     | Each runs a Bedrock planning call       |
| WebSocket connects | 5 / hour     | Each opens a billable Sonic stream      |
| Interview turns    | 60 / session | Caps runaway loop cost                  |
| Session wall-clock | 30 min       | Hard cap on a single open Sonic stream  |
| All routes         | 100 / minute | General abuse floor                     |

These are cost controls first and abuse controls second. A bug that reconnects
in a loop can run up real Bedrock spend in minutes, and nothing else in the
system will notice.

The wall-clock cap matters more than it looks. Sonic bills by stream duration,
not by turns taken, so an idle open stream is pure loss — the per-turn limit
alone does not bound cost.

---

## 6. What is deliberately not exposed

The original route sketch had `/chat`, `/speak`, `/evaluate`, `/plan`, and
`/coach` — one endpoint per agent. Those are gone. Agents are internal
functions, not a public surface: exposing `/speak` means anyone with a token
can bill arbitrary speech synthesis, and exposing `/chat` gives away raw
Bedrock access wrapped in your credentials.

Routes are organised around session resources instead. The agent that services
a request is an implementation detail.

`POST /transcribe` is absent for a different reason — it could not have worked.
See [ADR-0001](../adr/0001-websocket-transport-for-transcribe.md). The upstream
has since changed from Transcribe to Nova 2 Sonic
([ADR-0005](../adr/0005_nova_sonic_speech_to_speech.md)), but the transport
argument is unaffected: the upstream is still bidirectional and still cannot be
served by a request/response route.

---

## Related

- [`overview.md`](./overview.md) — system architecture
- [`data-model.md`](./data-model.md) — persisted shapes
- [ADR-0001](../adr/0001-websocket-transport-for-transcribe.md) — transport
- [ADR-0002](../adr/0002-alb-not-api-gateway.md) — ALB and idle timeout
- [ADR-0005](../adr/0005_nova_sonic_speech_to_speech.md) — voice loop