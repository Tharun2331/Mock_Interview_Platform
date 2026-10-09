import { rateLimit, ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";
import { config } from "./config";
import { MESSAGES } from "./messages";
import { DynamoRateLimitStore } from "./rateLimitStore";

// Keyed on the authenticated Cognito subject rather than the IP, so candidates
// behind one corporate NAT are not throttled as a single caller. Mounted after
// AuthMiddleware, so `req.user` is set; the IP fallback only covers the case of
// it being mounted earlier by mistake. `ipKeyGenerator` normalises IPv6 into a
// subnet so a client cannot trivially rotate addresses within its own /64.
//
// The store is chosen by RATE_LIMIT_STORE. `memory` (the default) counts per
// ECS task, so past one task the effective limit is `limit x taskCount`.
// `dynamodb` shares the count across tasks through the sessions table (see
// lib/rateLimitStore.ts). Redis was the original plan and was dropped in ADR-0006.
//
// `passOnStoreError` is on for the shared store: if DynamoDB errors, the request
// goes through rather than failing. That is fail-OPEN, chosen deliberately: the
// limiter protects cost, and the routes behind it carry their own hard spend
// limits (lib/budget.ts and the interview quota) that do not fail open. An API
// that 500s whenever the limiter's table hiccups would be the worse outage.
export const apiRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.rateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  ...(config.rateLimitStore === "dynamodb"
    ? { store: new DynamoRateLimitStore(), passOnStoreError: true }
    : {}),
  keyGenerator: (req: Request, _res: Response): string =>
    req.user?.id ?? ipKeyGenerator(req.ip ?? ""),
  message: { message: MESSAGES.RATE_LIMITED },
});

// The credential-taking auth routes (ADR-0011): sign-in, its TOTP step,
// sign-up and confirm. Keyed on the IP, because there is no Cognito subject
// yet, and tighter than the API limiter, because a password-guessing script
// hammers exactly these. Cognito throttles too, but per pool rather than per
// caller, so one script could otherwise exhaust sign-in for everybody.
//
// The `auth:` prefix keeps these counts apart from apiRateLimiter's IP
// fallback when both share the DynamoDB store.
export const authRateLimiter = rateLimit({
  windowMs: config.rateLimitWindowMs,
  limit: config.authRateLimitMaxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  ...(config.rateLimitStore === "dynamodb"
    ? { store: new DynamoRateLimitStore(), passOnStoreError: true }
    : {}),
  keyGenerator: (req: Request, _res: Response): string =>
    `auth:${ipKeyGenerator(req.ip ?? "")}`,
  // Same shape as every other auth failure, so the client needs one mapping.
  message: { code: "TOO_MANY_ATTEMPTS" },
});
