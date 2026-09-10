import { describe, expect, it } from "bun:test";
import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import {
  isTimeout,
  isUnauthorized,
  isUnreachable,
  serverFailure,
  serverMessage,
  statusOf,
  transportMessage,
} from "@/lib/httpErrors";
import { MESSAGES } from "@/lib/messages";

// Where a failure lands on screen depends on whose problem it is, and these
// functions are what decide. Getting the scope wrong sends a candidate
// re-picking PDFs to fix a server outage — so the distinctions are tested
// rather than assumed.

const headers = new AxiosHeaders();
const config = { headers };

function withResponse(status: number, data: unknown): AxiosError {
  const response = { status, data, statusText: "", headers, config } as AxiosResponse;
  return new AxiosError("failed", "ERR_BAD_RESPONSE", config, null, response);
}

function withoutResponse(code: string): AxiosError {
  return new AxiosError("failed", code, config, null, undefined);
}

describe("isUnauthorized", () => {
  it("is true only for a 401", () => {
    expect(isUnauthorized(withResponse(401, {}))).toBe(true);
    expect(isUnauthorized(withResponse(403, {}))).toBe(false);
    expect(isUnauthorized(withResponse(500, {}))).toBe(false);
  });

  it("is false for anything that is not an axios error", () => {
    expect(isUnauthorized(new Error("boom"))).toBe(false);
    expect(isUnauthorized(null)).toBe(false);
    expect(isUnauthorized("401")).toBe(false);
  });
});

// A timeout and an unreachable server look identical — both carry no response —
// but they are opposite situations, and telling someone to check their
// connection when the server simply took too long sends them to fix nothing.
describe("isTimeout vs isUnreachable", () => {
  it("treats an aborted connection as a timeout, not as unreachable", () => {
    const error = withoutResponse("ECONNABORTED");

    expect(isTimeout(error)).toBe(true);
    expect(isUnreachable(error)).toBe(false);
  });

  it("treats ETIMEDOUT the same way", () => {
    const error = withoutResponse("ETIMEDOUT");

    expect(isTimeout(error)).toBe(true);
    expect(isUnreachable(error)).toBe(false);
  });

  it("treats a network failure with no code as unreachable", () => {
    const error = withoutResponse("ERR_NETWORK");

    expect(isUnreachable(error)).toBe(true);
    expect(isTimeout(error)).toBe(false);
  });

  it("treats a real HTTP response as neither", () => {
    const error = withResponse(500, {});

    expect(isTimeout(error)).toBe(false);
    expect(isUnreachable(error)).toBe(false);
  });
});

describe("statusOf", () => {
  it("reports the status when there was a response", () => {
    expect(statusOf(withResponse(413, {}))).toBe(413);
  });

  it("is undefined when there was none", () => {
    expect(statusOf(withoutResponse("ERR_NETWORK"))).toBeUndefined();
    expect(statusOf(new Error("boom"))).toBeUndefined();
  });
});

// Returns null rather than a fallback so callers can tell "the server explained
// itself" from "we are guessing" — the difference between showing their words
// and ours.
describe("serverMessage", () => {
  it("returns the server's own message", () => {
    expect(serverMessage(withResponse(400, { message: "That file is 12 MB." }))).toBe(
      "That file is 12 MB."
    );
  });

  it("returns null for an empty message rather than an empty string", () => {
    expect(serverMessage(withResponse(400, { message: "" }))).toBeNull();
  });

  it("returns null when the body has no message field", () => {
    expect(serverMessage(withResponse(400, { error: "nope" }))).toBeNull();
    expect(serverMessage(withResponse(400, "plain text"))).toBeNull();
    expect(serverMessage(withResponse(400, null))).toBeNull();
  });

  it("returns null when message is not a string", () => {
    expect(serverMessage(withResponse(400, { message: 42 }))).toBeNull();
  });
});

describe("serverFailure", () => {
  // 400/413/422 describe what the candidate sent, so they belong beside the
  // field they can actually change.
  it.each([400, 413, 422])("scopes %d to the field", (status) => {
    expect(serverFailure(withResponse(status, { message: "too big" }))).toEqual({
      message: "too big",
      scope: "field",
    });
  });

  // A 500 means the server could not do its job. Showing that beside a file
  // input sends someone re-picking PDFs to fix something that is not theirs.
  it.each([500, 502, 503])("scopes %d globally", (status) => {
    expect(serverFailure(withResponse(status, { message: "our fault" }))).toEqual({
      message: "our fault",
      scope: "global",
    });
  });

  // 503 is the redaction path failing closed — ours, not theirs.
  it("puts the redaction failure in the global scope, not on the file field", () => {
    const failure = serverFailure(
      withResponse(503, { message: MESSAGES.PROFILE_LOAD_FAILED })
    );

    expect(failure?.scope).toBe("global");
  });

  it("returns null when the server sent no message to show", () => {
    expect(serverFailure(withResponse(400, {}))).toBeNull();
  });

  // A status outside both lists has no defined home on screen, so the caller
  // falls back rather than guessing.
  it("returns null for a status it has no placement rule for", () => {
    expect(serverFailure(withResponse(418, { message: "teapot" }))).toBeNull();
    expect(serverFailure(withResponse(409, { message: "conflict" }))).toBeNull();
  });
});

describe("transportMessage", () => {
  it("prefers the session-expired message for a 401", () => {
    expect(transportMessage(withResponse(401, {}), "fallback")).toBe(
      MESSAGES.FORM_SESSION_EXPIRED
    );
  });

  it("distinguishes a timeout from an unreachable server", () => {
    expect(transportMessage(withoutResponse("ECONNABORTED"), "fallback")).toBe(
      MESSAGES.FORM_TIMED_OUT
    );
    expect(transportMessage(withoutResponse("ERR_NETWORK"), "fallback")).toBe(
      MESSAGES.FORM_UNREACHABLE
    );
  });

  it("falls back for anything it cannot classify", () => {
    expect(transportMessage(new Error("boom"), "fallback")).toBe("fallback");
    expect(transportMessage(withResponse(500, {}), "fallback")).toBe("fallback");
  });
});
