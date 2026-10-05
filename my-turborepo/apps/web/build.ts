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
        `Mirror it from the Terraform cognito module outputs before building.`,
    );
  }
  return value;
};

// The API origin the bundle talks to. https:// only: the interview socket takes
// its scheme from this URL, so an http:// base would ship a bundle that sends
// the access token and the candidate's microphone audio in plaintext.
const requireHttpsApiUrl = (key: string): string => {
  const value = requireBuildEnv(key);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${key} is not a valid URL: ${value}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(
      `${key} must be an https:// URL for a production build, got ${url.protocol}//. ` +
        `The interview WebSocket derives wss:// from it.`,
    );
  }
  return value.replace(/\/+$/, "");
};

// Resolved BEFORE the output directory is cleared, so a misconfigured build
// leaves the previous dist/ intact instead of deleting it and then failing.
const define = {
  "process.env.NODE_ENV": JSON.stringify("production"),
  "process.env.BUN_PUBLIC_REGION": JSON.stringify(
    requireBuildEnv("BUN_PUBLIC_REGION"),
  ),
  "process.env.BUN_PUBLIC_COGNITO_USER_POOL_ID": JSON.stringify(
    requireBuildEnv("BUN_PUBLIC_COGNITO_USER_POOL_ID"),
  ),
  "process.env.BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID": JSON.stringify(
    requireBuildEnv("BUN_PUBLIC_COGNITO_USER_POOL_CLIENT_ID"),
  ),
  "process.env.BUN_PUBLIC_API_URL": JSON.stringify(
    requireHttpsApiUrl("BUN_PUBLIC_API_URL"),
  ),
  // Required: a deployed sign-up form without its human check would have every
  // sign-up refused once the pre sign-up trigger enforces it.
  "process.env.BUN_PUBLIC_TURNSTILE_SITE_KEY": JSON.stringify(
    requireBuildEnv("BUN_PUBLIC_TURNSTILE_SITE_KEY"),
  ),
  // Optional: unset falls back to dev's hosted-UI domain in lib/config.ts.
  // Defined either way, so the bundle never reads `process.env` at runtime.
  "process.env.BUN_PUBLIC_COGNITO_DOMAIN": JSON.stringify(
    process.env.BUN_PUBLIC_COGNITO_DOMAIN ?? "",
  ),
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
  // No source maps in the deployed bundle. "linked" published a .map next to
  // every chunk, which served the whole unminified frontend (comments included)
  // to anyone who asked. Debug locally with `bun --hot` instead.
  sourcemap: "none",
  // Load-bearing: without it Google sign-in hangs forever on /callback.
  //
  // Amplify registers the listener that exchanges the hosted-UI `?code=` for
  // tokens as a side-effect import inside signInWithRedirect, and declares that
  // file in @aws-amplify/auth's `sideEffects` list. Bun's bundler does not apply
  // that list, treats the import as dead and drops it — and an explicit
  // `import "aws-amplify/auth/enable-oauth-listener"` is dropped the same way.
  // With no listener, getCurrentUser() waits on an exchange nobody starts.
  // `bun --hot` does not tree-shake, so this only ever breaks deployed builds.
  //
  // The cost is ~50 KB of minified JS (~5%), from also ignoring @__PURE__
  // hints. Check before removing: in dist/, the Symbol("oauth-listener")
  // variable must be called as `X[sym](...)`, not only defined as a method.
  ignoreDCEAnnotations: true,
  // Root-absolute asset URLs. Bun emits `./chunk-x.js` by default, which
  // resolves against the current path: fine on /signin, but a full load of a
  // nested route like /results/:sessionId asked for /results/chunk-x.js, which
  // the CloudFront route rewrite (it only rewrites dotless paths) passed to S3
  // as a missing key — a 403 and a blank page on refresh.
  publicPath: "/",
  define,
});

// The microphone AudioWorklet is loaded by URL, so it ships as its own
// unhashed file at the path lib/audio/capture.ts requests. Copied rather than
// bundled: it runs on the audio thread and imports nothing.
await Bun.write(
  path.join(outdir, "pcm-capture.worklet.js"),
  Bun.file("src/lib/audio/pcmCaptureWorklet.js"),
);

for (const output of result.outputs) {
  console.log(
    ` ${path.relative(process.cwd(), output.path)}  ${(output.size / 1024).toFixed(1)} KB`,
  );
}
