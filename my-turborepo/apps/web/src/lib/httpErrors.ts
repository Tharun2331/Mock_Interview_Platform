import axios from "axios";
import { MESSAGES } from "@/lib/messages";

// Lifted out of pages/form.tsx when it split into the profile page and the
// interview setup page. Both need the same distinctions, and the distinctions
// are the point: which of these a failure is decides where it belongs on screen
// and whether retrying can possibly help.

// The server rejects an unverifiable token with 401. That is a session problem,
// not a bad input, so it gets its own message rather than the generic one.
export function isUnauthorized(error: unknown): boolean {
  return axios.isAxiosError(error) && error.response?.status === 401;
}

// The client's own timeout firing. It looks identical to "unreachable" — an
// axios error carrying no response — but it is the opposite situation: the
// server took the request and never answered, so telling someone to check their
// connection sends them to fix something that is not broken.
export function isTimeout(error: unknown): boolean {
  return (
    axios.isAxiosError(error) &&
    (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT")
  );
}

// No response at all: the request never reached a server that could answer, so
// this is a dropped connection, a backend that is not running, or CORS.
export function isUnreachable(error: unknown): boolean {
  return (
    axios.isAxiosError(error) && error.response === undefined && !isTimeout(error)
  );
}

export function statusOf(error: unknown): number | undefined {
  return axios.isAxiosError(error) ? error.response?.status : undefined;
}

// The server's own `message`, when it sent one. Returns null rather than a
// fallback so callers can tell "the server explained itself" from "we are
// guessing", which is the difference between showing their words and ours.
export function serverMessage(error: unknown): string | null {
  if (!axios.isAxiosError(error)) return null;

  const data: unknown = error.response?.data;
  if (
    typeof data === "object" &&
    data !== null &&
    "message" in data &&
    typeof (data as { message: unknown }).message === "string"
  ) {
    const message = (data as { message: string }).message;
    return message.length > 0 ? message : null;
  }
  return null;
}

export type ServerFailure = { message: string; scope: "field" | "global" };

// Where a failure belongs on screen depends on whose problem it is.
//
// 400/413/422 describe what the candidate sent — the exact size, the exact
// limit — so they belong on the field, next to the thing they can change. A 500
// means the server could not do its job; showing that beside their file input
// would send them re-picking PDFs to fix something that is not theirs.
//
// 503 is the redaction path failing closed. It is ours, not theirs, and the
// copy has to say the resume was not saved rather than implying the file was
// bad — see the RedactionError branch in the server's profile route.
export function serverFailure(error: unknown): ServerFailure | null {
  const message = serverMessage(error);
  if (message === null) return null;

  const status = statusOf(error);
  if (status === 400 || status === 413 || status === 422) {
    return { message, scope: "field" };
  }
  if (status === 500 || status === 502 || status === 503) {
    return { message, scope: "global" };
  }
  return null;
}

// The transport-level fallbacks every call site shares. Server-authored
// messages are handled by the caller, because only the caller knows which field
// they belong beside.
export function transportMessage(error: unknown, fallback: string): string {
  if (isUnauthorized(error)) return MESSAGES.FORM_SESSION_EXPIRED;
  if (isTimeout(error)) return MESSAGES.FORM_TIMED_OUT;
  if (isUnreachable(error)) return MESSAGES.FORM_UNREACHABLE;
  return fallback;
}
