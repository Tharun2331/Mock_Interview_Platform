import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./lib/config";
import { planRouter } from "./routes/plan";
import { preInterviewRouter } from "./routes/preInterview";
import { AuthMiddleware } from "./lib/cognitoAuth";
import { apiRateLimiter } from "./lib/rateLimit";
const app = express();

// Behind the ALB, req.ip is the load balancer without this. One hop, not `true`
// — a blanket trust lets a client spoof X-Forwarded-For and defeat any IP-based
// limiting. The limiter keys on the Cognito subject so this barely matters
// today, but the IP fallback and future IP logging both depend on it.
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: config.corsOrigins }));
app.use(express.json({ limit: config.jsonBodyLimit }));

// AuthMiddleware runs first so the limiter can key on the Cognito subject
// rather than the IP. The cost is that an unauthenticated flood still reaches
// token verification — that is JWKS-cached and local, so it is cheap, whereas
// the GitHub quota this protects is not.
app.use("/api/v1/pre-interview", AuthMiddleware, apiRateLimiter, preInterviewRouter);
app.use("/api/v1/plan", AuthMiddleware, apiRateLimiter, planRouter);

app.listen(config.port);
