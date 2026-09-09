# ADR-0007: Candidate material is user-scoped, redacted, and lazily replanned

- **Status:** Accepted
- **Date:** 2026-09-09
- **Amends:** [ADR-0006](0006-drop-redis-dynamodb-alone.md) — same single-table
  store, three new item types under `USER#<uid>`.

## Context

Resume and GitHub material was session-scoped. `POST /pre-interview` took a
multipart upload, parsed the PDF, scraped GitHub and created a session, all in
one request, **once per interview**.

It is the same resume every time. That shape produced four separate problems:

1. **N copies of one file.** `resumes/<uid>/<sid>.pdf` meant no way to answer
   "what is this candidate's current resume" without reading their sessions to
   find out.
2. **A Planner call per interview**, even when nothing about the candidate had
   changed since the last one.
3. **Raw resume text in DynamoDB and in model prompts.** `SESSION#<sid>/INPUTS`
   stored the full extraction — name, address, phone — and handed it to Bedrock.
4. **Re-uploading a PDF to start an interview**, which is friction on the path a
   returning candidate takes most often.

## Decision

### Material moves to `USER#<uid>`

Three new items: `PROFILE` (the candidate's material), `PLAN` (the last plan
generated), and the existing `SESSION#<sid>` refs. Captured once at onboarding;
every session reads from there.

`isProfileComplete` — resume present plus a name — is the onboarding gate. It is
computed server-side and shipped as a boolean on the profile view rather than
re-derived in the browser: two implementations of "ready to interview" would
eventually disagree about who gets redirected.

### The redacted text lives in DynamoDB; S3 holds only the archive

The PDF is stored at a **stable key**, `resumes/<uid>/resume.pdf`, overwritten on
re-upload. It keeps its PII deliberately — the candidate uploaded it knowingly,
it is the archive a parser change is re-run against, and it is theirs to
download.

What the Planner reads is the **redacted text**, stored on the profile item next
to `profileVersion` so both are written in one atomic update. Split across two
stores, a failure between them leaves new material behind a stale version
marker: the plan cache silently fails to invalidate and the Planner reasons over
a resume that is no longer the candidate's.

**Raw extracted text is never persisted.** It exists only in memory, between the
parser and the redactor.

### PII detection is Amazon Comprehend, and fails closed

`DetectPiiEntities` on the extracted text, plus one deterministic pattern for
unformatted phone numbers — the single category where Comprehend was measured to
return nothing at all. Identifiers are replaced with typed placeholders
(`[NAME]`, `[EMAIL]`) rather than deleted, so the text stays readable and a model
cannot invent a plausible name to fill a gap.

`DATE_TIME` is deliberately **not** stripped. Employment dates are what the
Planner reasons over to judge seniority; removing them leaves a resume saying
what someone did with no indication of when or for how long.

If Comprehend fails, the upload fails. Storing what the deterministic pass alone
caught would put names and addresses in DynamoDB with nothing downstream able to
tell the difference. The cost is that onboarding depends on Comprehend
availability — accepted, because an upload that fails is recoverable and one
that succeeds with PII still in it is not.

### Plans are invalidated lazily, at plan time

`profileVersion` is an integer bumped by `ADD` — atomic, so two concurrent
uploads cannot both read 3 and both write 4. It is bumped **only** when
Planner-relevant material changes: editing a display name does not touch it,
because a name has no bearing on the plan.

A cached plan is reusable when its `profileVersion` **and** its normalised
`targetRole` both match. Nothing is recomputed when a profile is saved; the
check happens when a plan is about to be used.

The comparison is against the **session's** `profileVersion`, not the profile's
current one. Those differ only when a candidate edits their profile between
starting a session and planning it, and there the session's is correct: the
Planner reads that session's `INPUTS` snapshot, so a plan is reusable exactly
when it was built from the same snapshot.

### Erasure is ordered, not atomic

`DELETE /api/v1/profile` marks the profile `deleting`, sweeps sessions, S3 and
the user partition, then deletes the Cognito identity last. Every delete is
idempotent and the marker is removed last, so a sweep that dies halfway leaves
an account already locked out and a marker saying the job is unfinished — and
running it again completes it.

Cognito goes last because it is the one irreversible step. If it fails, the data
is already gone and the candidate can still sign in, landing on onboarding.
Deleting the identity first would strand any surviving data with no way to
authenticate a retry.

## Consequences

**A denormalised copy needs a deleter, not just a writer.** The
`USER#<uid>/SESSION#<sid>` refs describe a session but live in the user's
partition, so neither the session sweep nor the profile sweep owned them. They
survived every erasure — invisibly, since nothing reads a ref whose session is
gone. `docs/architecture/data-model.md` now records writer, deleter and TTL per
item type; a blank cell is a leak.

**Comprehend is not Bedrock.** CLAUDE.md locks inference to Bedrock. This is
recorded as a deliberate exception: the rule is about model inference and the
agents behind it, and a purpose-built PII detector beats an LLM at recall on the
one job that must not silently miss anything. Scoped to
`comprehend:DetectPiiEntities` — the async job APIs, which read and write S3 on
the caller's behalf, are not granted.

**Re-upload is destructive**, and versioning is deliberately off. What is lost is
the candidate's own file, which they still have. Versioning solves accidental
deletion, not the staleness this design cares about — that is `profileVersion`.
The overwrite is safe only because parsing and redaction happen first, in
memory: a failure in either leaves the previous object untouched.

**Sessions still snapshot their material.** `INPUTS` is a copy, not a pointer.
An interview was conducted against the material as it stood when it started, and
a candidate who updates their resume next month must not retroactively change
what a past session was scored against.

## Rejected: Amazon Macie for PII detection

Macie is asynchronous, bucket-level discovery. It reports findings on objects
already in S3, minutes to hours later, and has no API that returns a redacted
document. It cannot run inline in an upload request, which is where the
redaction has to happen if raw text is never to be stored.

## Rejected: reading material from the profile at plan time

Removes the `INPUTS` copy and the snapshot problem with it. Also means a past
session's plan and scores refer to material that no longer exists, which makes
the transcript unreadable as a record. The duplication is the point.
