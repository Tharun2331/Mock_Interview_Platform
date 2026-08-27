import { ulid } from "ulid";
import { Router } from "express";
import axios from "axios";
import { z } from "zod";
import {
  PreInterviewBody,
  extractGithubUsername,
  type PreInterviewRepo,
  type PreInterviewResume,
} from "@repo/shared";
import { config } from "../lib/config";
import { UPLOAD } from "../lib/constants";
import {
  GithubError,
  ResumeParseError,
  ServiceError,
  UploadError,
} from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import {
  isMultipart,
  readMultipart,
  readPdf,
  readTextField,
} from "../lib/multipart";
import { parseResume } from "../lib/resume";
import { putResume } from "../lib/s3";
import { createSession } from "../lib/sessions";

export const preInterviewRouter = Router();

const GithubRepoSchema = z.object({
  description: z.string().nullable(),
  name: z.string(),
  full_name: z.string(),
  stargazers_count: z.number(),
});

const GithubReposSchema = z.array(GithubRepoSchema);

async function fetchRepos(username: string): Promise<PreInterviewRepo[]> {
  let response;
  try {
    response = await axios.get(
      // Encoded despite passing the username allowlist — defence in depth, so
      // this stays safe if the allowlist is ever widened.
      `${config.githubApiBase}/users/${encodeURIComponent(username)}/repos`,
      { timeout: config.githubTimeoutMs }
    );
  } catch (error) {
    // Wrapped rather than left as an AxiosError so the route can tell this
    // apart from every other failure in the handler.
    throw new GithubError(
      `${MESSAGES.GITHUB_FETCH_FAILED} — ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  const parsed = GithubReposSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new GithubError(MESSAGES.GITHUB_FETCH_FAILED);
  }

  return parsed.data.map((repo) => ({
    description: repo.description,
    name: repo.name,
    fullName: repo.full_name,
    starCount: repo.stargazers_count,
  }));
}

// Stores the original PDF and returns its extracted text. The raw file is kept
// so a future parser change can be re-run against past uploads rather than
// asking candidates to re-submit.
async function ingestResume(args: {
  userId: string;
  sessionId: string;
  bytes: Uint8Array;
}): Promise<{ resume: PreInterviewResume; resumeKey: string }> {
  const [resumeKey, parsed] = await Promise.all([
    putResume(args),
    parseResume(args.bytes),
  ]);

  return {
    resume: {
      characters: parsed.characters,
      pages: parsed.pages,
      text: parsed.text,
      usable: parsed.characters >= UPLOAD.MIN_USEFUL_RESUME_CHARS,
    },
    // Returned rather than recomputed by the caller. The key is what the
    // session record points at, and deriving it twice is how the two drift.
    resumeKey,
  };
}

preInterviewRouter.post("/", async (req, res) => {
  // ULID, not UUID. The id becomes the `SESSION#<sid>` sort-key suffix in the
  // user-history item, and ULIDs sort lexicographically by creation time — so a
  // Query returns a candidate's sessions oldest-first with no sort attribute and
  // no client-side sort. A v4 UUID would return them in random order.
  const sessionId = ulid();

  try {
    // The resume is required, so every request carries a file and JSON is no
    // longer a valid shape for this endpoint.
    if (!isMultipart(req)) {
      res.status(415).json({ message: MESSAGES.EXPECTED_MULTIPART });
      return;
    }

    const form = await readMultipart(req);

    if (!form.has(UPLOAD.RESUME_FIELD)) {
      res.status(400).json({ message: MESSAGES.RESUME_REQUIRED });
      return;
    }

    const { bytes: pdfBytes } = await readPdf(form, UPLOAD.RESUME_FIELD);

    const parsedBody = PreInterviewBody.safeParse({
      gitHub: readTextField(form, UPLOAD.GITHUB_FIELD),
    });
    if (!parsedBody.success) {
      res.status(400).json({
        message: MESSAGES.INVALID_BODY,
        errors: parsedBody.error.flatten(),
      });
      return;
    }

    // Optional now. The schema already proved the URL parses when present, so a
    // null here means the field was simply omitted.
    const username =
      parsedBody.data.gitHub === undefined
        ? null
        : extractGithubUsername(parsedBody.data.gitHub);

    // AuthMiddleware guarantees req.user; the guard narrows the optional type.
    const userId = req.user?.id;
    if (userId === undefined) {
      res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
      return;
    }

    // The two ingestions are independent, so they overlap rather than queue —
    // the PDF parse is CPU-bound and the GitHub call is network-bound. With no
    // GitHub profile there is simply nothing to scrape, which is not an error.
    const [repos, ingested] = await Promise.all([
      username === null ? Promise.resolve<PreInterviewRepo[]>([]) : fetchRepos(username),
      ingestResume({ userId, sessionId, bytes: pdfBytes }),
    ]);

    // After the ingestion, not before: there is no session worth recording
    // until the resume is actually stored. Before the response, not after, so a
    // candidate never receives a sessionId that POST /plan will then reject.
    //
    // Caught here rather than by the handler below, which would tell them their
    // resume failed to store. It did store — the record of it did not.
    try {
      await createSession({
        sessionId,
        userId,
        resumeKey: ingested.resumeKey,
        githubUsername: username,
        // Stored server-side so POST /plan reads them from the session rather
        // than from its own request body. They are still returned below for the
        // client to display — returning candidate material is fine, accepting it
        // back as the Planner's input is not.
        repos,
        resumeText: ingested.resume.text,
      });
    } catch (error) {
      console.error(
        `[pre-interview] ${error instanceof Error ? error.message : error}`
      );
      res.status(500).json({ message: MESSAGES.SESSION_UNAVAILABLE });
      return;
    }

    res.json({ sessionId, repos, resume: ingested.resume });
  } catch (error) {
    // Upload problems describe what the caller sent, so the message is safe to
    // return and actionable — "That file is 12.4 MB. The limit is 8.0 MB."
    if (error instanceof UploadError) {
      res.status(413).json({ message: error.message });
      return;
    }

    if (error instanceof ResumeParseError) {
      res.status(422).json({ message: error.message });
      return;
    }

    // 500, and the detail stays in the log. The candidate's file was fine; the
    // server could not do its job, and telling them to try another PDF would
    // send them chasing a problem that is not theirs.
    if (error instanceof ServiceError) {
      console.error(`[pre-interview] ${error.message}`);
      res.status(500).json({ message: MESSAGES.UPLOAD_UNAVAILABLE });
      return;
    }

    // 502 only for a genuine upstream failure. Previously this was the
    // catch-all, so any bug in the handler — or a crashed dependency — was
    // reported to the candidate as a bad GitHub URL, sending them to re-check
    // something that was never wrong.
    if (error instanceof GithubError) {
      console.error(`[pre-interview] ${error.message}`);
      res.status(502).json({ message: MESSAGES.GITHUB_FETCH_FAILED });
      return;
    }

    console.error(`[pre-interview] ${error instanceof Error ? error.message : error}`);
    res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
  }
});
