import type { NextFunction, Request, Response } from "express";
import { config } from "./config";
import { MESSAGES } from "./messages";

// CSRF defence for cookie authentication (ADR-0011).
//
// Once the session rides in a cookie, the browser attaches it to any request
// aimed at this API, including one a hostile page triggers. SameSite=Strict
// already stops a cross-SITE page sending it. This closes the remaining gap: a
// page on the same site but a different origin — any other *.tharunsekar.xyz
// host — which SameSite treats as friendly.
//
// A browser always sends Origin on a cross-origin request and on any POST, so a
// state-changing request from a page outside the allowlist carries an Origin
// that is not in it. A request with no Origin at all is not a browser acting on
// a candidate's behalf (curl, a test client) and carries no candidate's cookie,
// so it passes. `null` (sandboxed frames, some redirects) is not in the list
// and is refused.
//
// CORS alone is not this control: it stops a hostile page READING a response,
// not the request being sent and acted on.

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || config.corsOrigins.includes(origin);
}

export function requireAllowedOrigin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (SAFE_METHODS.has(req.method) || isAllowedOrigin(req.headers.origin)) {
    next();
    return;
  }
  console.warn(
    `[origin] refused ${req.method} ${req.path} from ${req.headers.origin ?? "none"}`,
  );
  res.status(403).json({ error: MESSAGES.ORIGIN_REFUSED });
}
