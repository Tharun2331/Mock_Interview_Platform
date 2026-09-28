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
import { apiRateLimiter } from "./lib/rateLimit";
const app = express();

// Behind the ALB, req.ip is the load balancer without this. One hop, not `true`
// — a blanket trust lets a client spoof X-Forwarded-For and defeat any IP-based
// limiting. The limiter keys on the Cognito subject so this barely matters
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
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: config.jsonBodyLimit }));

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
