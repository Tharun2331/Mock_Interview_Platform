const env = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
};

export const config = {
  port:                   Number(env("PORT", "8000")),
  corsOrigin:             env("CORS_ORIGIN", "http://localhost:3000"),
  awsRegion:              env("AWS_REGION", "us-east-1"),
  githubApiBase:          env("GITHUB_API_BASE", "https://api.github.com"),
  cognitoUserPoolId:       requireEnv("COGNITO_USER_POOL_ID"),
  cognitoUserPoolClientId: requireEnv("COGNITO_USER_POOL_CLIENT_ID"),
} as const;
