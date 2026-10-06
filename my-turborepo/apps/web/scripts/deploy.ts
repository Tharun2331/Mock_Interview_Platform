// Builds the web app for one environment and publishes it behind CloudFront.
//
//   bun run deploy          # dev
//   bun run deploy prod
//
// Every build-time value comes from that environment's Terraform outputs, not
// from apps/web/.env: copying ids by hand is how a dev bundle ends up pointed
// at prod's user pool. Values set here override anything .env would supply.
//
// Needs `terraform` and the AWS CLI on PATH, with credentials that can write
// the frontend bucket and invalidate the distribution.
import { $ } from "bun";
import path from "node:path";

const environment = process.argv[2] ?? "dev";
const webDir = path.resolve(import.meta.dir, "..");
const terraformDir = path.resolve(
  webDir,
  `../../infra/terraform/environments/${environment}`,
);

type TerraformOutputs = Record<string, { value: unknown }>;

const outputs = (await $`terraform -chdir=${terraformDir} output -json`
  .quiet()
  .json()) as TerraformOutputs;

const requireOutput = (key: string, hint = ""): string => {
  const value = outputs[key]?.value;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Terraform output "${key}" is empty for ${environment}. ${hint}`.trim(),
    );
  }
  return value;
};

const userPoolId = requireOutput("cognito_user_pool_id");
// Set whether or not the API server is running: its hostname is fixed, so the
// site can be published while the API is switched off.
const apiUrl = requireOutput("api_url");
const bucket = requireOutput("frontend_bucket_id");
const distributionId = requireOutput("frontend_distribution_id");

// --- Build -------------------------------------------------------------------
// The region is the user pool id's prefix (us-east-1_xxxx), so it cannot
// disagree with the pool it belongs to.
await $`bun run build.ts`.cwd(webDir).env({
  ...process.env,
  BUN_PUBLIC_REGION: userPoolId.split("_")[0]!,
  BUN_PUBLIC_COGNITO_USER_POOL_ID: userPoolId,
  BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID: requireOutput(
    "cognito_user_pool_client_id",
  ),
  BUN_PUBLIC_API_URL: apiUrl,
  BUN_PUBLIC_TURNSTILE_SITE_KEY: requireOutput("turnstile_site_key"),
  // Required, not left to config.ts's fallback: that fallback is dev's domain,
  // so a prod bundle built without this would send Google sign-in to the dev
  // user pool.
  BUN_PUBLIC_COGNITO_DOMAIN: requireOutput("cognito_domain"),
});

// --- Publish -----------------------------------------------------------------
// Two cache classes. Bundled assets carry a content hash in their name, so a
// changed file is a new URL and the old one can be cached forever. These two
// keep a fixed name, so browsers must revalidate them on every load or a deploy
// would never reach anyone holding the old copy.
const unhashed = ["index.html", "pcm-capture.worklet.js"];
const dist = path.join(webDir, "dist");
const excludes = unhashed.flatMap((file) => ["--exclude", file]);

// Hashed assets first, so the new index.html never references a file that is
// not there yet. Old hashed files are left in place: a candidate mid-session
// on the previous bundle still loads its lazy chunks.
await $`aws s3 sync ${dist} s3://${bucket} ${excludes} --cache-control ${"public, max-age=31536000, immutable"} --no-progress`;

for (const file of unhashed) {
  await $`aws s3 cp ${path.join(dist, file)} s3://${bucket}/${file} --cache-control no-cache --no-progress`;
}

// Edges may still hold the previous index.html for up to its old TTL.
const invalidationId =
  await $`aws cloudfront create-invalidation --distribution-id ${distributionId} --paths ${unhashed.map((file) => `/${file}`)} --query Invalidation.Id --output text`.text();

console.log(
  `\nDeployed ${environment} web app against ${apiUrl}` +
    `\nInvalidation ${invalidationId.trim()} — live within a minute or two.`,
);
