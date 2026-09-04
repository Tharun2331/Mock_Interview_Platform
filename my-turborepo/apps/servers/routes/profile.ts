import { Router, type Request, type Response } from "express";
import {
  PLAN_LIMITS,
  ProfileDetailsBody,
  extractGithubUsername,
  toProfileView,
  type PreInterviewRepo,
} from "@repo/shared";
import { UPLOAD } from "../lib/constants";
import {
  GithubError,
  ProfileStateError,
  RedactionError,
  ResumeParseError,
  ServiceError,
  UploadError,
} from "../lib/errors";
import { fetchRepos } from "../lib/github";
import { MESSAGES } from "../lib/messages";
import {
  isMultipart,
  readMultipart,
  readPdf,
  readTextField,
} from "../lib/multipart";
import { getProfile, saveProfileDetails, saveResumeAndRepos } from "../lib/profile";
import { redactResumeText } from "../lib/redact";
import { parseResume } from "../lib/resume";
import { putResume } from "../lib/s3";

// The candidate's material, captured once instead of per interview. Everything
// here is user-scoped: sessions read the profile, never the other way round.

export const profileRouter = Router();

// Shared by all three handlers. AuthMiddleware guarantees req.user; this only
// narrows the optional type, and returns null so the caller can respond and
// bail without a second nesting level.
function requireUserId(req: Request, res: Response): string | null {
  const userId = req.user?.id;
  if (userId === undefined) {
    res.status(401).json({ error: MESSAGES.UNAUTHORIZED_INVALID_TOKEN });
    return null;
  }
  return userId;
}

// Every handler ends the same way, and the ordering matters more than it looks:
// the specific classes have to be tested before ServiceError, and the catch-all
// must never quote an error it cannot classify.
function handleFailure(res: Response, error: unknown): void {
  if (error instanceof UploadError) {
    res.status(413).json({ message: error.message });
    return;
  }

  if (error instanceof ResumeParseError) {
    res.status(422).json({ message: error.message });
    return;
  }

  // 409: the account is mid-erasure. Ownership is already proven, so saying so
  // leaks nothing and the candidate needs to know the write did not land.
  if (error instanceof ProfileStateError) {
    res.status(409).json({ message: error.message });
    return;
  }

  // 503, not 500. Redaction failing closed means the resume was rejected rather
  // than stored, and the honest thing to tell someone is that this is temporary
  // and worth retrying — not that their file was bad.
  if (error instanceof RedactionError) {
    console.error(`[profile] ${error.message}`);
    res.status(503).json({ message: MESSAGES.REDACTION_UNAVAILABLE });
    return;
  }

  if (error instanceof GithubError) {
    console.error(`[profile] ${error.message}`);
    res.status(502).json({ message: MESSAGES.GITHUB_FETCH_FAILED });
    return;
  }

  if (error instanceof ServiceError) {
    console.error(`[profile] ${error.message}`);
    res.status(500).json({ message: MESSAGES.PROFILE_UNAVAILABLE });
    return;
  }

  console.error(`[profile] ${error instanceof Error ? error.message : error}`);
  res.status(500).json({ message: MESSAGES.UNEXPECTED_FAILED });
}

// Null profile, not 404. A candidate who has never saved one is the expected
// state on first sign-in, and it is exactly what the onboarding guard asks this
// route to tell it.
profileRouter.get("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  try {
    const profile = await getProfile({ userId });
    res.json({ profile: profile === null ? null : toProfileView(profile) });
  } catch (error) {
    handleFailure(res, error);
  }
});

// Display fields only. Deliberately does not touch profileVersion: a name has
// no bearing on the interview plan, so invalidating the cached one here would
// buy a Bedrock call for nothing.
profileRouter.put("/", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  const parsed = ProfileDetailsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      message: MESSAGES.INVALID_BODY,
      errors: parsed.error.flatten(),
    });
    return;
  }

  try {
    const profile = await saveProfileDetails({ userId, ...parsed.data });
    res.json({ profile: toProfileView(profile) });
  } catch (error) {
    handleFailure(res, error);
  }
});

// Resume upload, and the only place resume text is ever produced.
//
// The write order is the whole design. Parsing, scraping and redaction all
// happen in memory first; S3 and DynamoDB are touched only once all three have
// succeeded. A failure anywhere before that leaves the previous profile exactly
// as it was, which is what makes overwriting a stable S3 key safe.
profileRouter.post("/resume", async (req, res) => {
  const userId = requireUserId(req, res);
  if (userId === null) return;

  try {
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

    const rawGithub = readTextField(form, UPLOAD.GITHUB_FIELD);
    // A blank field arrives as "" rather than absent. Folded to undefined so an
    // untouched input reads as "not given" instead of as an invalid URL.
    const githubInput =
      typeof rawGithub === "string" && rawGithub.trim().length === 0
        ? undefined
        : rawGithub;

    let username: string | null = null;
    if (githubInput !== undefined) {
      username = extractGithubUsername(githubInput);
      if (username === null) {
        res.status(400).json({ message: MESSAGES.INVALID_GITHUB_URL });
        return;
      }
    }

    // Independent work, so it overlaps rather than queues: the PDF parse is
    // CPU-bound and the GitHub call is network-bound. No GitHub profile means
    // nothing to scrape, which is not an error.
    const [repos, parsed] = await Promise.all([
      username === null
        ? Promise.resolve<PreInterviewRepo[]>([])
        : fetchRepos(username),
      parseResume(pdfBytes),
    ]);

    // Truncated before redaction, not after. This is the text that gets stored,
    // so scanning anything beyond the cap would pay Comprehend to read
    // characters that are discarded a moment later — and it is what keeps the
    // input inside the API's size limit by construction.
    const capped = parsed.text.slice(0, PLAN_LIMITS.MAX_RESUME_CHARS);
    const redaction = await redactResumeText(capped);

    // Nothing above this line has written anything. From here it is S3 first,
    // then DynamoDB: the object is the archive and the item is what every read
    // path actually uses, so a failure between them leaves an orphaned object
    // rather than a profile pointing at one that was never stored.
    const key = await putResume({ userId, bytes: pdfBytes });

    const profile = await saveResumeAndRepos({
      userId,
      resumeKey: key,
      // Redacted. lib/profile.ts cannot verify that and does not try — this is
      // the only call site that produces this argument, and it is the reason
      // redaction failing has to fail the request.
      resumeText: redaction.text,
      repos,
      githubUsername: username,
    });

    res.json({
      profile: toProfileView(profile),
      resume: {
        characters: parsed.characters,
        pages: parsed.pages,
        usable: parsed.characters >= UPLOAD.MIN_USEFUL_RESUME_CHARS,
        redactedCount: redaction.redactedCount,
        redactedTypes: redaction.types,
      },
    });
  } catch (error) {
    handleFailure(res, error);
  }
});
