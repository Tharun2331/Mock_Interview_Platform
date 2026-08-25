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

// The PDF was accepted but its text could not be extracted.
export class ResumeParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResumeParseError";
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
