# ADR 0005: Amazon Nova 2 Sonic replaces Transcribe + Polly for the interview voice loop

- **Status:** Accepted
- **Date:** 2026-08-18
- **Supersedes:** the voice-pipeline sections of ADR 0001 (WebSocket transport). The transport decision itself still holds.

## Context

The original Mock Interview voice loop was three hops:

```
mic → Transcribe streaming → text → Bedrock (Llama 3.1 8B) → text → Polly neural → audio
```

Three problems surfaced before implementation started:

1. **Latency stacks.** Each hop adds its own time-to-first-byte. The candidate hears nothing until Transcribe finalises, Llama produces its first token, and Polly synthesises the opening phoneme.
2. **Turn detection is ours to build.** Nothing in the chain decides when the candidate has stopped speaking. That means an `AudioWorklet` computing RMS, a silence threshold, endpointing heuristics tuned against `IsPartial` — days of tuning for behaviour that is table stakes in a voice product.
3. **Prosody is discarded at hop one.** Hesitation, filler density, and pace are exactly the signals a mock interview should react to. Transcribe throws them away before the model ever sees them.

Amazon Nova 2 Sonic (launched 2025-12-02) is a speech-to-speech foundation model on Bedrock. Audio in, audio out, one open bidirectional stream. It handles barge-in and turn taking natively and emits text transcripts as a side channel alongside the audio.

## Decision

Use **`amazon.nova-2-sonic-v1:0`** via `InvokeModelWithBidirectionalStream` for all live interview turns.

- SDK: `@aws-sdk/client-bedrock-runtime`, `InvokeModelWithBidirectionalStreamCommand`
- Audio in: 16 kHz, 16-bit PCM, mono. Audio out: 24 kHz LPCM
- Requires an HTTP/2 handler on the Node client (`NodeHttp2Handler`) — the default HTTP/1.1 handler cannot hold the duplex stream
- Amazon Transcribe and Amazon Polly are removed from the stack entirely

Text-only agents are unaffected and stay on Llama 3.1 8B via `ConverseCommand`:

| Agent | Model | API |
|---|---|---|
| Mock Interview (live turns) | `amazon.nova-2-sonic-v1:0` | `InvokeModelWithBidirectionalStream` |
| Planner | `meta.llama3-1-8b-instruct-v1:0` | `ConverseCommand` |
| Evaluator | `meta.llama3-1-8b-instruct-v1:0` | `ConverseCommand` |
| Coach | `meta.llama3-1-8b-instruct-v1:0` + Knowledge Bases | `ConverseCommand` |

> **Amendment, 2026-08-19 — text models only.** The text-agent model in the
> table above is superseded. The chain is now `mistral.ministral-3-8b-instruct`
> → `meta.llama4-scout-17b-instruct-v1:0` → `qwen.qwen3-coder-30b-a3b-v1:0`,
> matching `bedrock_text_model_ids` in the `iam` module. `meta.llama3-2-3b-instruct-v1:0`,
> named as the backup in the architecture doc at the time, was never available
> in `us-east-1`.
>
> **This does not change the decision this ADR records.** Sonic remains the
> speech-to-speech model, `amazon.nova-2-sonic-v1:0` is confirmed `ACTIVE` in
> `us-east-1` with `SPEECH` in and `SPEECH`+`TEXT` out, and Transcribe/Polly
> remain out of the stack. Only the incidental text-model reference has moved on.

### Transcript persistence

Sonic emits `textOutput` events carrying both the ASR transcript of the candidate (`role: USER`) and its own generated speech (`role: ASSISTANT`). The backend subscribes to these and writes them to DynamoDB under the existing session item. The Evaluator and Coach agents read text from DynamoDB and never touch audio — their signatures do not change.

## Consequences

**Gained**

- One network hop instead of three; conversational latency rather than walkie-talkie latency
- Native barge-in and turn detection — the endpointing work is deleted before it is written
- The model reacts to tone and hesitation, not just words
- Two fewer AWS service integrations to build, IAM, and monitor

**Lost**

- Model choice for interview turns. Sonic is the model; Llama and Mistral are no longer swappable there. The multi-model fallback chain now applies only to text agents.
- Direct control over the intermediate text. Prompt-level steering of the interview happens through the system prompt and tool configuration rather than by editing text between hops.
- Voice selection is Sonic's, not Polly's — Joanna/Matthew are gone.
- Region availability is narrower than Transcribe/Polly. Confirm the region in Terraform before assuming parity.

**Unchanged**

- The browser ↔ backend WebSocket is still hand-rolled. Sonic replaces the middle of the pipeline, not the connection management around it. Ticket-based auth, reconnection, and session resume all still need building.
- ALB, ECS Fargate, Redis session state, DynamoDB single-table design.

## Cost

Roughly $3 per million speech input tokens and $12 per million speech output tokens — on the order of $0.015/minute of conversation. Verify against the Bedrock pricing page before relying on this; it is close enough to the Transcribe + Polly + Llama combination that cost was not the deciding factor either way.

Sonic bills continuously while the stream is open. An interview session left open in a browser tab accrues cost with no user present — close streams on disconnect and enforce a hard session cap. This is the same discipline already applied to the NAT Gateway.

## Alternatives considered

- **Keep the three-hop chain.** Rejected: the latency and turn-detection work is substantial and produces a worse conversation.
- **LiveKit.** Rejected: puts a third-party SFU in the media path, contradicts the AWS-only constraint, and its agent-worker model is the separate-process shape deliberately deferred to v2. It also abstracts away the streaming integration this project exists to demonstrate.