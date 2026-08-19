import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";
import { config } from "./config";
import { MESSAGES } from "./messages";

// Keyed on the authenticated Cognito subject rather than the IP, so candidates
// behind one corporate NAT are not throttled as a single caller. Mounted after
// AuthMiddleware, so `req.user` is set; the IP fallback only covers the case of
// it being mounted earlier by mistake. `ipKeyGenerator` normalises IPv6 into a
// subnet so a client cannot trivially rotate addresses within its own /64.
//
// The default store is IN-MEMORY, which means this budget is per ECS task. Once
// the service scales past a single task the effective limit becomes
// `limit x taskCount`, so this must move to a Redis store at that point — the
// `ratelimit:<uid>:<minute>` key layout in docs/architecture/data-model.md is
// the intended destination, and it lands with the Phase 3 Redis work.
export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: Request, _res: Response): string =>
    req.user?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: { message: MESSAGES.RATE_LIMITED },
});
