---
name: preppilot-frontend
description: "The single source of frontend guidance for PrepPilot AI. Use it for anything under apps/web — visual direction for the landing and auth pages, the live mock interview screen, recorder and transcript UI, evaluation and coach results, resume/GitHub upload flows, the session history dashboard, shadcn theming, and Jest tests for UI state. Use it even when the request sounds narrowly functional ('add a stop button', 'the transcript jumps', 'style this card'), because the visual contract for interview states is what makes or breaks the product. Start by reading the routing section to decide which of the two modes applies."
---

# PrepPilot Frontend

PrepPilot has two frontend surfaces with genuinely opposite priorities. Applying the wrong rulebook is the most common way this project's UI goes wrong, so decide which one you are in before designing anything.

## Routing

| Surface | Examples | Priority |
|---|---|---|
| **Identity** | Landing page, sign-in, onboarding, empty first-run screens | Distinctiveness. This is the portfolio impression. |
| **App** | Interview screen, transcript, evaluation, coach, history, settings | Legibility of system state. Boldness here costs the user. |

A screen can be both — the first-run empty state is an app screen doing identity work. When in doubt, ask which failure is worse: forgettable, or ambiguous. On the interview screen, ambiguous is always worse.

## Stack facts (non-negotiable)

- React is bundled with **`Bun.build()` and `bun-plugin-tailwind`**. There is no Vite. Never write `vite.config.ts`, `import.meta.env`, or reference a Vite plugin.
- **shadcn/ui** over Tailwind. Extend the CSS-variable layer; never introduce a second component library or a CSS-in-JS runtime.
- **Cognito via Amplify**. Auth has four renderable conditions: bootstrapping, signed out, signed in, and expired-mid-session. The last one is the one that will hit during a 20-minute interview.
- Types come from **`packages/shared`** as Zod schemas. Derive UI props with `z.infer` rather than hand-writing duplicates. Before importing a schema, confirm it exists — if it doesn't, define it in `packages/shared` first. The UI requirement is often what reveals a missing field.
- Tests are **Jest**.

### Audio capture and playback

The interview loop talks to a speech-to-speech model over one WebSocket. This constrains the client more than a typical audio feature would:

- **Capture is an `AudioWorklet`, never `MediaRecorder`.** `MediaRecorder` emits WebM/Opus containers; the backend needs raw 16 kHz 16-bit PCM mono frames. Any code or guidance referencing `MediaRecorder` for the interview loop is stale. The worklet downsamples from the context's native rate — usually 48 kHz — and posts `Int16Array` chunks.
- **Playback is 24 kHz LPCM** arriving as binary frames on the same socket. Buffer and schedule it through Web Audio; there is no MP3 blob to hand to an `<audio>` element.
- **The mic stays open while the interviewer speaks.** The model detects turn-taking itself and supports interruption, so muting during playback would break the product's best feature.
- That last point creates a real hazard: **an open mic during playback will capture the interviewer's own voice.** `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })` is mandatory, and browser AEC only cancels what it knows it played. Route playback through the same audio graph the browser recognises as output rather than an exotic path, and test on speakers, not just headphones. A feedback loop here doesn't crash anything — it quietly makes the model respond to itself, which is far harder to diagnose from a bug report.
- Never leak model or service names into the UI. The user is talking to "the interviewer."

---

# Mode A — Identity surfaces

Approach these as the design lead at a small studio known for giving every client a visual identity that could not be mistaken for anyone else's. Make deliberate, opinionated choices about palette, typography, and layout specific to this brief, and take one real aesthetic risk you can justify.

**Ground it in the subject.** The subject here is interview preparation — nerves, preparation, the moment before speaking, the gap between what you know and what you can say under pressure. That world has its own materials and vernacular. Distinctive choices come from there, not from a stock SaaS vocabulary.

**The hero is a thesis.** Open with the most characteristic thing in the subject's world, in whatever form fits: a headline, a live demo, an interactive moment. A big number with a small label plus a gradient accent is the template answer — use it only if it is genuinely the best option.

**Typography carries the personality.** Pair display and body faces deliberately, not the families you would reach for on any other project. Set a clear type scale with intentional weights and spacing. Make the type treatment itself memorable rather than a neutral delivery vehicle.

**Structure is information.** Numbering, eyebrows, dividers, and labels should encode something true about the content. Numbered markers (01 / 02 / 03) only belong where the content is genuinely a sequence.

**Motion, deliberately.** One orchestrated moment usually lands harder than scattered effects. Extra animation is a strong tell that a design was AI-generated.

**Calibration.** AI-generated design currently clusters around three looks: warm cream background with a high-contrast serif and terracotta accent; near-black with a single acid-green or vermilion accent; broadsheet layout with hairline rules, zero radius, and dense columns. All are legitimate for some briefs, but they appear regardless of subject. Where a brief pins down a direction, follow it exactly. Where it leaves an axis free, don't spend that freedom on one of these defaults.

**Two passes.** First brainstorm a compact token system — palette as 4–6 named hex values, typefaces for 2+ roles, a layout concept, and the single signature element the page will be remembered by. Then review that plan against the brief: if any part reads like the generic default you'd produce for any similar page, revise it and say what changed and why. Only then write code.

**Restraint.** Spend boldness in one place. Let the signature element be the one memorable thing and keep everything around it quiet. Before shipping, remove one accessory.

---

# Mode B — App surfaces

Behind the login, a person is mid-answer with a microphone open. Uncertainty about system state makes them stop performing like a candidate and start debugging the app, which destroys the product's core value.

## Theme the tokens, don't fight the components

Customize shadcn at the variable layer — `--background`, `--primary`, `--muted`, `--destructive`, `--radius`. Add project-specific semantic tokens so interview states mean the same thing everywhere:

```css
--state-recording   /* mic is live and the candidate has the floor */
--state-processing  /* candidate stopped, model has not started */
--state-speaking    /* interviewer audio is playing back */
--state-listening   /* interviewer speaking, mic still open for interruption */
--score-strong / --score-mixed / --score-weak
```

`--state-listening` is not decoration. The mic is open during playback, and a user who doesn't know that will either talk over the interviewer by accident or sit silent waiting for a cue that never comes. It needs its own visual identity, distinct from both recording and speaking.

If a component needs `bg-red-500` inline to express "recording," the token system has a hole. Fill the hole.

Keep body text highly legible at small sizes — transcripts are read under time pressure, so this is not the place for a characterful body face. Use tabular numerals wherever scores appear, so a column of 0–10 ratings does not shimmer as it updates.

## The interview state machine is the design

Model it as a discriminated union and render from it. Never from independent booleans like `isRecording && !isLoading`, which is how contradictory UI ships.

| State | What the user must know instantly | Contract |
|---|---|---|
| `idle` | Nothing is being captured | Neutral surface, primary action reads "Start answer" |
| `requesting-permission` | The browser is asking, not the app | Explain why the mic is needed *before* the prompt appears |
| `permission-denied` | The app is blocked and how to unblock it | Recovery instructions naming the browser's own UI |
| `recording` | Audio is live and they have the floor | Loudest signal on screen, plus a live input-level meter |
| `processing` | They stopped, the interviewer hasn't started | Progress distinguishing "sent" from "stalled" |
| `interviewer-speaking` | The interviewer is talking, and they *may* interrupt | Playback affordance, skip control, and a live mic indicator |
| `interrupting` | Their voice cut the interviewer off, deliberately or not | Playback stops instantly; treat as a transition into `recording` |
| `error` | What broke and what to do | Specific cause, one clear next action |

`interrupting` is the state that distinguishes this design from a turn-based one. It is entered by the *user's voice*, not by a button or a server message, which makes it the only transition in the machine with no explicit trigger in the UI. Two consequences: it must be reachable from `interviewer-speaking` in the type definition, and the transition must be fast enough to feel causal — if playback keeps going for half a second after someone starts talking, they will stop and apologise to a machine.

Three rules outrank every aesthetic choice here:

**The recording indicator must be driven by real audio, not a state flag.** Read levels off an `AnalyserNode` and render measured amplitude. A dot that pulses while the mic is muted at OS level is worse than no indicator, because it actively lies. Detect sustained silence and surface it.

**The mic indicator must stay visible during `interviewer-speaking`.** The mic is genuinely open. Hiding that is a privacy misrepresentation, not just a UX gap — the user believes they are not being heard while they are. This is the one state where the honest thing and the tidy thing diverge, and honesty wins.

**Stopping must always be reachable.** Never disabled, never behind a menu, never hidden during processing. A person who wants to stop talking and cannot is the worst experience this product can produce.

**Keep state and its handlers in the same hook.** Returning state without the handler that updates it forces adapter functions at the call site.

## Latency choreography

One hop instead of three means audio starts fast, but "fast" is not "instant" and silence still reads as a crash. What changed is where the wait lives: there is no transcription pause before generation, so the gap sits entirely between the candidate's last word and the interviewer's first sound.

- Stream partial transcripts into the transcript as low-emphasis text, promoted to full emphasis when final. The difference between "we think you said" and "you said" should need no legend. Both the candidate's words and the interviewer's arrive this way, distinguished by role.
- Key transcript rows on a stable id from the stream, never on array index — index keys remount rows on every partial and cause visible jumping.
- The interviewer's transcript is a record of audio already playing, not a preview of it. Never gate playback on text arriving, and never render the question as settled before its audio finishes — the two are independent event streams on one connection.
- Never put a spinner where streamed content will land. Reserve the space and fill it.
- Skeletons only for content whose shape is known in advance, such as the score card. Never skeleton a transcript of unknown length.
- Auto-scroll only while the reader is already at the bottom. If they scrolled up to re-read, incoming partials must not yank them away — offer a "Jump to latest" control instead.
- Give every model call a visible timeout path with a retry.

Keep animation functional here: input level, state transitions, streamed text. Ambient motion beside a live transcript competes with the thing being read.

## Empty, error, and permission states are primary screens

These are the most common first-run experience, not edge cases.

- **Mic denied or missing** — explain what PrepPilot needs, why, and where the browser control lives. Offer a text fallback rather than a dead end.
- **No interviews yet** — this is the onboarding screen. An invitation to start, not an apology for empty data.
- **No resume or GitHub connected** — say what each unlocks concretely ("questions drawn from your own projects"), not as a nag banner.
- **Session expired mid-interview** — preserve the recorded answer, prompt to re-authenticate, resume. Losing an answer to a token refresh is unacceptable.
- **Connection dropped mid-interview** — reconnecting starts a fresh model stream with no memory of the conversation, so the interviewer will repeat or re-ask. Say so plainly rather than letting the user think they are losing their mind. "Reconnected. The interviewer will repeat the last question."
- **Model or network failure mid-turn** — distinguish "your answer was saved, the question failed" from "your answer was lost." Users need to know whether to repeat themselves.
- **Session time limit approaching** — sessions are capped, and hitting the cap mid-answer is a bad surprise. Warn before it lands, not after.

## Forms and uploads

Resume upload and GitHub connect are the first real interaction. Wire `react-hook-form` with `zodResolver` against the shared schemas so client and server validate identically.

- Validate on blur, not on every keystroke. Errors that appear mid-typing read as scolding.
- Reject files at the boundary and say why in the same sentence as the limit: "That file is 12 MB. The limit is 8 MB."
- Show parse progress as distinct phases — uploading, extracting text, reading — because PDF parsing is slow enough that one undifferentiated bar looks stalled.
- A parse that yields little text is a *result*, not an error. Show what was extracted and let the user proceed or re-upload.
- GitHub connect is an OAuth round trip: render a pending state that survives the redirect, and never imply the token reaches the browser.

## Data density

The history dashboard is a different problem from the interview screen — tables and trends, not state machines.

- Default sort to most recent. Show date, role, and headline score in the row; push detail behind the row.
- Score trends across rounds are the point of keeping history. One small chart of the three dimensions over time beats a wall of numbers.
- Empty and single-row states both need designing; a trend chart with one point should say so rather than render a lonely dot.
- Paginate server-side against DynamoDB's cursor, not by fetching everything and slicing.
- If an answer was given over an interrupted question, show that in the detail view. A score on a half-heard question needs its context.

## Working with shadcn: wrap, don't fork

Default to wrapping a shadcn component in a project component that encodes PrepPilot's semantics — `<ScoreCard>` wrapping `Card`, not a forked `Card`. Fork only when the change is structural (different DOM, different accessibility behaviour), and when you do, note why in a comment at the top of the file. Forks silently miss upstream fixes, so each one is a standing cost.

---

## Visual References
Before styling or building any screen, check `docs/design/references/README.md` 
for a relevant reference image, then `view` it directly before writing component code.
Treat these as the visual source of truth over generic shadcn defaults.


# Applies to both modes

## Writing in the interface

Words are design material, not decoration.

- Name things the way a candidate thinks about them: "Start answer," "Interview round," "Feedback." Never leak agent, model, or AWS service names into user-facing strings.
- Keep an action's name stable through its flow: "Start answer" → "Recording your answer" → "Answer recorded."
- Active voice, sentence case, plain verbs. "Save changes," not "Submit."
- Errors state what happened and what to do, without apologising or blaming: "Your microphone is blocked. Allow access in your browser's address bar, then try again."
- Say that interruption is allowed, once, early, in plain words: "You can jump in any time — the interviewer will stop." Users default to turn-taking politeness with software and will not discover this on their own.
- Scores need plain-language anchors. A bare "7/10 depth" teaches nothing — pair each dimension with one sentence naming what would have made it stronger.
- Feedback reads as coaching, not judgement. Users are already nervous; be direct about weaknesses without being demeaning.

## Quality floor

- Full keyboard path through the interview loop with visible focus rings. Start and stop both keyboard-reachable.
- State changes announced via a polite live region — recording, processing, interviewer speaking. An audio-first product that signals state only visually is self-defeating.
- Interruption needs its own announcement, and it is the one state change worth an assertive live region rather than a polite one: the user's own voice caused it, and stale audio feedback would contradict what they just heard happen.
- `prefers-reduced-motion` respected; the level meter degrades to a static state indicator rather than vanishing.
- Colour is never the only channel. Every state and score band carries an icon or label too.
- Contrast checked on the score palette specifically — weak/mixed/strong on a light surface is the usual failure.
- Layout holds at 375px. Practising on a phone is a real use case. Phones also default to speaker output, which is where echo cancellation is tested for real.

## Testing UI state with Jest

The state machine is the highest-value thing to test, because its failures are invisible in a happy-path demo.

- Assert that impossible states are unreachable: no transition produces both `recording` and `processing`.
- Assert stop is enabled in every state where the mic is open — which now includes `interviewer-speaking`.
- Assert the level meter reads zero when the analyser reports silence, so the indicator can never lie in a regression.
- Assert the mic indicator renders in `interviewer-speaking`. This is the test that stops someone "tidying up" the UI by hiding it.
- Test the interruption transition: a simulated input-level event during `interviewer-speaking` must stop playback and land in `recording`, with no intermediate state where both are true.
- Test transcript keying: a partial update to an existing id must not unmount the row.
- Mock `getUserMedia` rejections by `DOMException` name and assert each maps to its own recovery message.
- `AudioWorklet` does not exist in jsdom. Stub the worklet boundary and test the hook's state transitions against injected frames rather than trying to run real audio in Jest — resampling correctness belongs in a manual check, not a unit test.

## Before writing code

Sketch the state machine and name every state, including failures, before touching JSX. Then check the plan against two questions. If the network stalled for eight seconds in each state, would the user know what was happening and what to do? And in every state where the mic is open, does the interface say so? If any state fails either test, the design is not finished.

