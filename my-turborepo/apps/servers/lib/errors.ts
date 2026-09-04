// Thrown when a Bedrock call cannot produce a usable result — every model in
// the fallback chain failed, or the generation came back unparseable.
//
// Carries the models attempted so a log line says which chain was exhausted.
// The message is for logs, never for the client: it can contain AWS internals
// and prompt fragments, so routes map this to a generic response.
// A rejected upload: too large, wrong type, or malformed multipart. Unlike
// BedrockError these messages ARE safe to show the user — they describe what
// they sent and how to fix it — so routes pass them through as 413.
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

// The server is misconfigured or a dependency failed — a missing bucket name, a
// rejected S3 write. Deliberately separate from UploadError: the candidate did
// nothing wrong and cannot fix it, so this must not surface as a field error
// telling them to pick a different file. Routes map it to 500 with a generic
// message and keep the detail in the log.
export class ServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

// The GitHub scrape failed — unreachable, rate-limited, or a response that did
// not match the expected shape.
//
// Exists so the route can tell a real GitHub failure from any other error in
// the same handler. Without it the catch-all blamed GitHub for everything,
// which sends a candidate to re-check a URL that was never wrong.
export class GithubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubError";
  }
}

// The PDF was accepted but its text could not be extracted.
export class ResumeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeParseError";
  }
}

// The session does not exist, or it belongs to someone else. Deliberately one
// error rather than two: routes map it to a single 404, so the response cannot
// be used to test whether a given session id is real.
export class SessionAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionAccessError";
  }
}

// The session exists and belongs to the caller, but is in a state where the
// requested change no longer makes sense — re-planning an interview that has
// already started. Separate from SessionAccessError because ownership is
// already proven here, so there is no enumeration concern and the response can
// say what is actually wrong.
export class SessionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionStateError";
  }
}

// The profile exists but is mid-erasure, so a write to it must not land. Not a
// SessionAccessError: there is no enumeration concern — the caller is
// authenticated as the owner — so the response can say what is actually wrong.
export class ProfileStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileStateError";
  }
}

export class BedrockError extends Error {
  readonly modelsTried: string[];

  constructor(message: string, modelsTried: string[] = []) {
    super(message);
    this.name = "BedrockError";
    this.modelsTried = modelsTried;
  }
}
