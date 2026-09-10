import { describe, expect, it } from "bun:test";
import {
  BedrockError,
  GithubError,
  ProfileStateError,
  RedactionError,
  ResumeParseError,
  ServiceError,
  SessionAccessError,
  SessionStateError,
  UploadError,
} from "../../lib/errors";

// Routes dispatch on these with `instanceof` and map each to a different status
// and a different message policy. Two of them being interchangeable is a real
// failure: UploadError messages are shown to the candidate, ServiceError
// messages must never be, and a catch-all that blames GitHub for everything
// sends people to re-check a URL that was never wrong.

const ERROR_CLASSES = [
  ["UploadError", UploadError],
  ["ServiceError", ServiceError],
  ["GithubError", GithubError],
  ["ResumeParseError", ResumeParseError],
  ["SessionAccessError", SessionAccessError],
  ["SessionStateError", SessionStateError],
  ["RedactionError", RedactionError],
  ["ProfileStateError", ProfileStateError],
  ["BedrockError", BedrockError],
] as const;

describe("error classes", () => {
  it.each(ERROR_CLASSES)("%s is a real Error carrying its message", (_name, Cls) => {
    const error = new Cls("something went wrong");

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("something went wrong");
  });

  // The `name` is what appears in logs, and several of these are otherwise
  // structurally identical — without it a log line cannot tell them apart.
  it.each(ERROR_CLASSES)("%s sets its own name", (name, Cls) => {
    expect(new Cls("x").name).toBe(name);
  });

  it.each(ERROR_CLASSES)("%s has a usable stack", (_name, Cls) => {
    expect(typeof new Cls("x").stack).toBe("string");
  });
});

// Each pairing below is one the routes actually have to tell apart.
describe("instanceof dispatch", () => {
  it("does not confuse a rejected upload with a broken server", () => {
    // UploadError messages are safe to show; ServiceError messages are not.
    expect(new UploadError("file too large")).not.toBeInstanceOf(ServiceError);
    expect(new ServiceError("bucket missing")).not.toBeInstanceOf(UploadError);
  });

  it("does not confuse a GitHub failure with any other handler failure", () => {
    expect(new GithubError("rate limited")).not.toBeInstanceOf(ServiceError);
    expect(new ServiceError("dynamo down")).not.toBeInstanceOf(GithubError);
  });

  // Ownership is already proven for SessionStateError, so it may say what is
  // wrong. SessionAccessError must stay a single opaque 404 or it becomes an
  // oracle for whether a session id is real.
  it("does not confuse a missing session with a wrong-state one", () => {
    expect(new SessionAccessError("no such session")).not.toBeInstanceOf(
      SessionStateError
    );
    expect(new SessionStateError("already started")).not.toBeInstanceOf(
      SessionAccessError
    );
  });

  // The fail-closed path: the response has to say the resume was rejected,
  // not that it was saved.
  it("does not confuse a redaction failure with a parse failure", () => {
    expect(new RedactionError("comprehend down")).not.toBeInstanceOf(ResumeParseError);
    expect(new ResumeParseError("no text")).not.toBeInstanceOf(RedactionError);
  });

  it("does not confuse an erasing profile with a missing session", () => {
    expect(new ProfileStateError("deleting")).not.toBeInstanceOf(SessionAccessError);
  });

  it("catches each class as a plain Error for the outer middleware", () => {
    for (const [, Cls] of ERROR_CLASSES) {
      expect(new Cls("x")).toBeInstanceOf(Error);
    }
  });
});

// Carries the models attempted so a log line says which chain was exhausted.
describe("BedrockError", () => {
  it("defaults modelsTried to an empty array", () => {
    expect(new BedrockError("all models failed").modelsTried).toEqual([]);
  });

  it("records the chain that was exhausted, in order", () => {
    const chain = [
      "mistral.ministral-3-8b-instruct",
      "us.meta.llama4-scout-17b-instruct-v1:0",
      "qwen.qwen3-coder-30b-a3b-v1:0",
    ];

    expect(new BedrockError("all models failed", chain).modelsTried).toEqual(chain);
  });

  it("is still a BedrockError when only one model was tried", () => {
    const error = new BedrockError("unparseable generation", [
      "mistral.ministral-3-8b-instruct",
    ]);

    expect(error).toBeInstanceOf(BedrockError);
    expect(error.modelsTried).toHaveLength(1);
  });
});
