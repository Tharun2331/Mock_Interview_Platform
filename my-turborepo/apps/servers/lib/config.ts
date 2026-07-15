const env = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

export const config = {
  port:          Number(env("PORT", "8000")),
  corsOrigin:    env("CORS_ORIGIN", "http://localhost:3000"),
  awsRegion:     env("AWS_REGION", "us-east-1"),
  githubApiBase: env("GITHUB_API_BASE", "https://api.github.com"),
} as const;
