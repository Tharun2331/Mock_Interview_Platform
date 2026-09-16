import { mock } from "bun:test";

// The single `lib/ssm` stub.
//
// `mock.module` is global and permanent for the process, so this lives in a
// helper rather than in whichever test needed it first — see the header of
// bedrockStub.ts for the CI-only failure that rule exists to prevent.
//
// Stubbed rather than pointed at a fake Parameter Store because the secret is
// not what any of these tests are about: what matters is that lib/tavily reads
// its key from SSM at all, which is asserted by this being the only place the
// key can come from.

let secret = "test-tavily-key";
let failure: Error | null = null;

export const getSecret = mock(async (_name: string): Promise<string> => {
  if (failure !== null) throw failure;
  return secret;
});

mock.module("../../lib/ssm", () => ({
  getSecret,
  resetSecretCache: () => {},
}));

/** A deployment where Terraform made the parameter and nobody filled it in. */
export function setSecretFailure(error: Error): void {
  failure = error;
}

export function resetSsmStub(): void {
  secret = "test-tavily-key";
  failure = null;
  getSecret.mockClear();
}
