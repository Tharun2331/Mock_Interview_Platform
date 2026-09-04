import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./lib/config";
import { planRouter } from "./routes/plan";
import { preInterviewRouter } from "./routes/preInterview";
import { profileRouter } from "./routes/profile";
import { attachInterviewSocket } from "./routes/interview";
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
// Rate limited like the rest: the resume handler fans out to Comprehend, S3 and
// DynamoDB on one request, which is the most expensive thing an authenticated
// caller can trigger here.
app.use("/api/v1/profile", AuthMiddleware, apiRateLimiter, profileRouter);
app.use("/api/v1/pre-interview", AuthMiddleware, apiRateLimiter, preInterviewRouter);
app.use("/api/v1/plan", AuthMiddleware, apiRateLimiter, planRouter);

// The HTTP server is captured rather than discarded: the interview WebSocket
// attaches to its `upgrade` event, which is the only place a handshake can be
// authenticated before a socket exists.
const server = app.listen(config.port);

attachInterviewSocket(server);
