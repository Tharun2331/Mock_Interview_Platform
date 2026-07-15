import { Router } from "express";
import axios from "axios";
import { z } from "zod";
import { PreInterviewBody } from "@repo/shared";
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

  const rawUrl = parsed.data.gitHub;
  const githubUrl = rawUrl.endsWith("/") ? rawUrl.slice(0, -1) : rawUrl;
  const githubUsername = githubUrl.split("/").pop();

  if (!githubUsername) {
    res.status(400).json({ message: MESSAGES.MISSING_GITHUB_USER });
    return;
  }

  try {
    const response = await axios.get(
      `${config.githubApiBase}/users/${githubUsername}/repos`
    );

    const reposResult = GithubReposSchema.safeParse(response.data);
    if (!reposResult.success) {
      res.status(502).json({ message: MESSAGES.GITHUB_FETCH_FAILED });
      return;
    }

    const repos = reposResult.data.map((repo) => ({
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
