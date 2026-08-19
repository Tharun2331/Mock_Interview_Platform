// Thrown when a Bedrock call cannot produce a usable result — every model in
// the fallback chain failed, or the generation came back unparseable.
//
// Carries the models attempted so a log line says which chain was exhausted.
// The message is for logs, never for the client: it can contain AWS internals
// and prompt fragments, so routes map this to a generic response.
export class BedrockError extends Error {
  readonly modelsTried: string[];

  constructor(message: string, modelsTried: string[] = []) {
    super(message);
    this.name = "BedrockError";
    this.modelsTried = modelsTried;
  }
}
