import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./lib/config";
import { planRouter } from "./routes/plan";
import { preInterviewRouter } from "./routes/preInterview";
import { gapRouter } from "./routes/gap";
import { companyIntelRouter } from "./routes/companyIntel";
import { coachRouter } from "./routes/coach";
import { profileRouter } from "./routes/profile";
import { sessionsRouter } from "./routes/sessions";
import { adminRouter } from "./routes/admin";
import { adminMetricsRouter } from "./routes/adminMetrics";
import { attachInterviewSocket } from "./routes/interview";
import { AuthMiddleware } from "./lib/cognitoAuth";
import { RequireAdmin } from "./lib/adminAuth";
import { metricsMiddleware } from "./lib/metrics";
import { apiRateLimiter, authRateLimiter } from "./lib/rateLimit";
import { requireAllowedOrigin } from "./lib/originCheck";
import { AUTH } from "./lib/constants";
import { authRouter, meRouter, mfaRouter } from "./routes/auth";
const app = express();

// Behind CloudFront, req.ip is CloudFront's VPC-origin ENI without this.
// CloudFront appends the viewer's address to X-Forwarded-For, so trusting one
// hop yields the viewer. One hop, not `true` — a blanket trust lets a client
// spoof X-Forwarded-For and defeat any IP-based limiting. The limiter keys on the Cognito subject so this barely matters
// today, but the IP fallback and future IP logging both depend on it.
app.set("trust proxy", 1);

// FIRST in the chain, ahead of helmet and cors, so the timer spans the whole
// request rather than only the part after the middleware finished.
//
// The two things this ordering buys are both things a later mount would hide: the
// latency of the middleware itself (a slow JSON parse on a large body is real
// latency a candidate waits through), and requests that never reach a router at
// all — a 429 from the rate limiter, a CORS rejection, a 404. Those are exactly
// the responses worth counting, and a timer mounted after them would report a
// perfectly healthy service while every request was being refused.
//
// It never throws and never blocks: see the wrapper in lib/metrics.ts.
app.use(metricsMiddleware);

app.use(helmet());
// `credentials: true` because the session is now a cookie (ADR-0011): without
// it the browser neither sends the cookie on the web app's cross-origin fetches
// nor lets the page see the response. It requires an exact origin list, never
// "*", which resolveCorsOrigins already guarantees in production.
app.use(cors({ origin: config.corsOrigins, credentials: true }));
// The CSRF control that cookie auth needs. Ahead of every route, including the
// public auth routes, where it stops a hostile page signing a candidate into
// an attacker's account. See lib/originCheck.ts.
app.use(requireAllowedOrigin);
app.use(express.json({ limit: config.jsonBodyLimit }));

// Auth (ADR-0011). The credential-taking routes get the per-IP limiter; it is
// mounted here rather than inside the router, like every other limiter, so the
// router's tests exercise the handlers rather than the throttle. A mount on
// /signin also covers /signin/totp.
app.use(
  [
    `${AUTH.ROUTE_PREFIX}/signin`,
    `${AUTH.ROUTE_PREFIX}/signup`,
    `${AUTH.ROUTE_PREFIX}/confirm`,
  ],
  authRateLimiter,
);
app.use(AUTH.ROUTE_PREFIX, authRouter);
app.use(`${AUTH.ROUTE_PREFIX}/me`, AuthMiddleware, meRouter);
app.use(`${AUTH.ROUTE_PREFIX}/mfa`, AuthMiddleware, apiRateLimiter, mfaRouter);

// AuthMiddleware runs first so the limiter can key on the Cognito subject
// rather than the IP. The cost is that an unauthenticated flood still reaches
// token verification — that is JWKS-cached and local, so it is cheap, whereas
// the GitHub quota this protects is not.
// Rate limited like the rest: the resume handler fans out to Comprehend, S3 and
// DynamoDB on one request, which is the most expensive thing an authenticated
// caller can trigger here.
app.use("/api/v1/profile", AuthMiddleware, apiRateLimiter, profileRouter);
app.use(
  "/api/v1/pre-interview",
  AuthMiddleware,
  apiRateLimiter,
  preInterviewRouter,
);
app.use("/api/v1/plan", AuthMiddleware, apiRateLimiter, planRouter);
// Read paths for a finished interview. Rate limited like the rest, though this
// one is polled while the worker drains — the limit is per authenticated user
// and generous enough that a few-second poll interval never reaches it.
app.use("/api/v1/sessions", AuthMiddleware, apiRateLimiter, sessionsRouter);
// Cognito-protected and rate limited like the rest: it runs a Bedrock call, so
// it is among the more expensive things an authenticated caller can trigger.
app.use("/api/v1/gap", AuthMiddleware, apiRateLimiter, gapRouter);
// Same protection as /gap: it runs a Bedrock call, so an unauthenticated
// caller here would be spending someone else's tokens.
app.use("/api/v1/company", AuthMiddleware, apiRateLimiter, companyIntelRouter);
// Reads only this candidate's own history, proven by the token rather than by
// anything in the request — there is no id in the path to get wrong.
app.use("/api/v1/coach", AuthMiddleware, apiRateLimiter, coachRouter);

// The admin surface. Three things about this mount are load-bearing:
//
//   1. `RequireAdmin` sits AFTER AuthMiddleware and BEFORE the router. The group
//      claim it reads only exists once a token has been verified, and mounting it
//      first would make it refuse every request — safely, but silently.
//   2. Both routers mount on the same path behind the same guard, so there is one
//      admin check rather than one per feature. No handler re-checks.
//   3. The rate limiter stays. An admin is not exempt: these routes fan out to
//      Cognito and CloudWatch, and a dashboard left polling in an open tab is the
//      most likely source of accidental load on either. It keys on the Cognito
//      subject, so an admin's budget is their own.
//
// `/metrics` is mounted before the user-management router because Express 5
// matches in order and a bare `/` route on the latter would otherwise shadow it.
app.use(
  "/api/v1/admin/metrics",
  AuthMiddleware,
  RequireAdmin,
  apiRateLimiter,
  adminMetricsRouter,
);
app.use(
  "/api/v1/admin",
  AuthMiddleware,
  RequireAdmin,
  apiRateLimiter,
  adminRouter,
);

// The HTTP server is captured rather than discarded: the interview WebSocket
// attaches to its `upgrade` event, which is the only place a handshake can be
// authenticated before a socket exists.
const server = app.listen(config.port);

attachInterviewSocket(server);
