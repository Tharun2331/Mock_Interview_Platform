import { Router } from "express";
import axios from "axios";
import { z } from "zod";
import {
  PreInterviewBody,
  extractGithubUsername,
  type PreInterviewRepo,
} from "@repo/shared";
import { config } from "../lib/config";
import { MESSAGES } from "../lib/messages";

export const preInterviewRouter = Router();

const GithubRepoSchema = z.object({
  description: z.string().nullable(),
  name: z.string(),
  full_name: z.string(),
  stargazers_count: z.number(),
});

const GithubReposSchema = z.array(GithubRepoSchema);

preInterviewRouter.post("/", async (req, res) => {
  const parsed = PreInterviewBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: MESSAGES.INVALID_BODY, errors: parsed.error.flatten() });
    return;
  }

  // The schema already guarantees this resolves; re-checking narrows the type
  // and keeps the route correct if the schema is ever loosened.
  const githubUsername = extractGithubUsername(parsed.data.gitHub);
  if (githubUsername === null) {
    res.status(400).json({ message: MESSAGES.MISSING_GITHUB_USER });
    return;
  }

  try {
    const response = await axios.get(
      // Encoded despite passing the username allowlist — defence in depth, so
      // this stays safe if the allowlist is ever widened.
      `${config.githubApiBase}/users/${encodeURIComponent(githubUsername)}/repos`,
      { timeout: config.githubTimeoutMs }
    );

    const reposResult = GithubReposSchema.safeParse(response.data);
    if (!reposResult.success) {
      res.status(502).json({ message: MESSAGES.GITHUB_FETCH_FAILED });
      return;
    }

    // Typed against the shared schema so a change to the projection breaks the
    // build rather than the client's runtime parse.
    const repos: PreInterviewRepo[] = reposResult.data.map((repo) => ({
      description: repo.description,
      name: repo.name,
      fullName: repo.full_name,
      starCount: repo.stargazers_count,
    }));

    res.json({ repos });
  } catch {
    res.status(500).json({ message: MESSAGES.GITHUB_FETCH_FAILED });
  }
});
