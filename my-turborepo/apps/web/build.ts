import tailwind from "bun-plugin-tailwind";
import { rm } from "node:fs/promises";
import path from "node:path";

// Fail the build rather than inlining "" for a missing value — an empty pool id
// produces a bundle that looks fine and breaks every auth call at runtime. CI
// should catch this, not the user.
const requireBuildEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required build-time variable: ${key}. ` +
        `Mirror it from the Terraform cognito module outputs before building.`
    );
  }
  return value;
};

// Resolved BEFORE the output directory is cleared, so a misconfigured build
// leaves the previous dist/ intact instead of deleting it and then failing.
const define = {
  "process.env.NODE_ENV": JSON.stringify("production"),
  "process.env.BUN_PUBLIC_REGION": JSON.stringify(requireBuildEnv("BUN_PUBLIC_REGION")),
  "process.env.BUN_PUBLIC_COGNITO_USER_POOL_ID": JSON.stringify(requireBuildEnv("BUN_PUBLIC_COGNITO_USER_POOL_ID")),
  "process.env.BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID": JSON.stringify(requireBuildEnv("BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID")),
};

const outdir = path.join(process.cwd(), "dist");
await rm(outdir, { recursive: true, force: true });

const entrypoints = [...new Bun.Glob("src/**/*.html").scanSync()];

const result = await Bun.build({
  entrypoints,
  outdir,
  plugins: [tailwind],
  minify: true,
  target: "browser",
  sourcemap: "linked",
  define,
});

for (const output of result.outputs) {
  console.log(` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`);
}
