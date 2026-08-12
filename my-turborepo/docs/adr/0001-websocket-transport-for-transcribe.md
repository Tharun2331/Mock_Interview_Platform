# ADR-0001: WebSocket transport for the live interview loop

**Status:** Accepted · **Date:** 2026-08-11

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