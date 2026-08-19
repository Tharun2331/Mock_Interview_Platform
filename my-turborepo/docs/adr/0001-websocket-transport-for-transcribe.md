# ADR-0001: WebSocket transport for the live interview loop

**Status:** Accepted · **Date:** 2026-08-11
**Amended:** 2026-08-18 — the upstream changed from Amazon Transcribe to Amazon
Nova 2 Sonic ([ADR-0005](./0005_nova_sonic_speech_to_speech.md)). The transport
decision below stands unchanged; see the amendment at the end for what no longer
applies.

## Context

The original route sketch had `POST /transcribe`. The live interview loop needs
to carry continuous microphone audio from the browser to Amazon Transcribe and
return transcripts as they form.

## Decision

Use a **WebSocket** between browser and Express server for the transcription
path. The server holds an open `TranscribeStreamingClient` session per
connection and relays partial transcripts back as they arrive.

Question generation and speech synthesis stay on HTTP.

| Step             | Transport         | Why                                                      |
| ---------------- | ----------------- | -------------------------------------------------------- |
| Audio → text     | WebSocket         | Bidirectional, continuous, revises partials               |
| Text → question  | HTTP + SSE stream | One prompt, one answer — streamed for perceived latency   |
| Question → audio | HTTP              | One text in, one audio blob out                           |

## Rejected: HTTP POST

Amazon Transcribe streaming is a bidirectional protocol. The client pushes
audio chunks continuously while the service pushes back partial transcripts,
revising them as more audio arrives. An HTTP POST is one request and one
response — there is no position in that shape to put a stream of partial
results. This wasn't a performance tradeoff; the endpoint could not have worked.

## Rejected: WebRTC

WebRTC's value is peer-to-peer NAT traversal and codec negotiation for
browser-to-browser media. Neither applies here — audio flows browser → our own
backend, and Transcribe streaming expects an HTTP/2 event stream, not SRTP over
UDP. WebSocket over TCP gives ordered, complete delivery, which is what STT
needs: a dropped audio chunk corrupts a transcript, and UDP's tolerance for loss
is a liability rather than a feature.

Self-hosted LiveKit as a WebRTC transport remains a v2 consideration if we ever
need multi-party sessions. It buys nothing for a single candidate talking to a
server.

## Consequences

- Express must manage per-connection Transcribe sessions and clean them up on
  disconnect. Leaked sessions bill by the minute.
- The ALB listener must be configured for WebSocket upgrade (see ADR-0002).
- Auth happens once at handshake, not per message — the JWT is validated on
  connect and the connection carries the identity thereafter.
- Reconnection mid-interview needs explicit handling: the session state lives in
  Redis, so a reconnect can resume, but the Transcribe stream restarts.

---

## Amendment — 2026-08-18

[ADR-0005](./0005_nova_sonic_speech_to_speech.md) replaced the
Transcribe → Bedrock → Polly chain with Amazon Nova 2 Sonic, a speech-to-speech
model reached through `InvokeModelWithBidirectionalStream`. What that changes
here:

**Still correct, and now more so.** The rejection of `POST /transcribe` holds
for the same reason under a different upstream: Sonic is also bidirectional and
also has no place in a request/response shape to put a continuous stream. The
rejection of WebRTC holds too — the argument was never Transcribe-specific. It
was that audio flows browser → our own backend over TCP, and that ordered,
complete delivery is what a speech model needs. Sonic expects an HTTP/2 event
stream, exactly as Transcribe did.

**No longer correct.** The three-row transport table above describes a pipeline
that no longer exists. There is no "text → question" HTTP step and no
"question → audio" HTTP step; both directions travel on the one WebSocket, and
`POST /speak` was never built. The table should be read as history.

**Changed in substance.** The per-connection resource Express must clean up is
now a Sonic bidirectional stream rather than a `TranscribeStreamingClient`
session. The leak risk is the same in kind and worse in degree — Sonic bills by
open stream duration, and there is no per-minute audio metering to make an idle
stream cheap.

**Changed on reconnect.** A restarted Transcribe stream lost only in-flight
partials. A restarted Sonic stream loses the entire conversation context, since
the model's state lives in the stream. Resuming means replaying prior turns into
a fresh stream or re-asking the question outright.