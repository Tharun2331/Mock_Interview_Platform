import { randomUUID } from "node:crypto";
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
import { ResumeParseError, ServiceError, UploadError } from "../lib/errors";
import { MESSAGES } from "../lib/messages";
import {
  isMultipart,
  readMultipart,
  readPdf,
  readTextField,
} from "../lib/multipart";
import { parseResume } from "../lib/resume";
import { putResume } from "../lib/s3";

export const preInterviewRouter = Router();

const GithubRepoSchema = z.object({
  description: z.string().nullable(),
  name: z.string(),
  full_name: z.string(),
  stargazers_count: z.number(),
});

const GithubReposSchema = z.array(GithubRepoSchema);

async function fetchRepos(username: string): Promise<PreInterviewRepo[]> {
  const response = await axios.get(
    // Encoded despite passing the username allowlist — defence in depth, so
    // this stays safe if the allowlist is ever widened.
    `${config.githubApiBase}/users/${encodeURIComponent(username)}/repos`,
    { timeout: config.githubTimeoutMs }
  );

  const parsed = GithubReposSchema.safeParse(response.data);
  if (!parsed.success) {
    throw new Error(MESSAGES.GITHUB_FETCH_FAILED);
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
}): Promise<PreInterviewResume> {
  const [, parsed] = await Promise.all([
    putResume(args),
    parseResume(args.bytes),
  ]);

  return {
    characters: parsed.characters,
    pages: parsed.pages,
    text: parsed.text,
    usable: parsed.characters >= UPLOAD.MIN_USEFUL_RESUME_CHARS,
  };
}

preInterviewRouter.post("/", async (req, res) => {
  const sessionId = randomUUID();

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
    const [repos, resume] = await Promise.all([
      username === null ? Promise.resolve<PreInterviewRepo[]>([]) : fetchRepos(username),
      ingestResume({ userId, sessionId, bytes: pdfBytes }),
    ]);

    res.json({ sessionId, repos, resume });
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

    console.error(`[pre-interview] ${error instanceof Error ? error.message : error}`);
    res.status(502).json({ message: MESSAGES.GITHUB_FETCH_FAILED });
  }
});
