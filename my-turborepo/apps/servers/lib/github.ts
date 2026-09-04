import axios from "axios";
import { z } from "zod";
import type { PreInterviewRepo } from "@repo/shared";
import { config } from "./config";
import { GithubError } from "./errors";
import { MESSAGES } from "./messages";

// Lifted out of routes/preInterview.ts when the profile took ownership of
// candidate material. Both routes scraped the same endpoint and projected the
// same four fields, and a second copy is how the two drift.

const GithubRepoSchema = z.object({
  description: z.string().nullable(),
  name: z.string(),
  full_name: z.string(),
  stargazers_count: z.number(),
});

const GithubReposSchema = z.array(GithubRepoSchema);

export async function fetchRepos(
  username: string
): Promise<PreInterviewRepo[]> {
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
