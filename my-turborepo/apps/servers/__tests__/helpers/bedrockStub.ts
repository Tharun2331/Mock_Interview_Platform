import { mock } from "bun:test";

// The single Bedrock stub, shared by every test that needs one.
//
// It exists because `mock.module` is GLOBAL and permanent for the process.
// Bun runs all test files in one process, so a file that replaces
// `agents/planner` replaces it for every file loaded afterwards too — and the
// later file gets the earlier file's stub instead of the real module.
//
// That is not hypothetical. routes/plan.test.ts used to mock `agents/planner`
// directly, and on Linux CI it silently hijacked all 24 tests in
// agents/planner.test.ts, which then asserted against a stub. Only the one
// assertion both fixtures happened to share still passed. It never reproduced
// on Windows, where the mock key does not match the same way — so the local
// suite was green while CI was right.
//
// The rule this encodes: mock the leaf that talks to the outside world
// (`lib/bedrock`), never an internal module another test is the subject of.
// One registration, one place, no ordering hazard.

export type ConverseArgs = {
  system: string;
  prompt: string;
  exampleTurns?: Array<{ user: string; assistant: string }>;
};

type Behaviour = { kind: "reply"; text: string } | { kind: "error"; error: Error };

// Mirrors lib/bedrock's ConverseResult. `modelId` is part of the contract, not
// a detail: the Evaluator persists it on every EVAL# item.
export type ConverseResult = { text: string; modelId: string };

const DEFAULT_MODEL_ID = "mistral.ministral-3-8b-instruct";

let behaviour: Behaviour = { kind: "reply", text: "" };
let modelId = DEFAULT_MODEL_ID;
let lastArgs: ConverseArgs | undefined;

export const converseText = mock(
  async (args: ConverseArgs): Promise<ConverseResult> => {
    lastArgs = args;
    if (behaviour.kind === "error") throw behaviour.error;
    return { text: behaviour.text, modelId };
  }
);

// Relative to THIS file, so it resolves to apps/servers/lib/bedrock.
mock.module("../../lib/bedrock", () => ({ converseText }));

/** What the model should return on the next call, and every call after it. */
export function setModelReply(text: string): void {
  behaviour = { kind: "reply", text };
}

/** Make the model call fail — the Bedrock chain exhausted, or a hang. */
export function setModelFailure(error: Error): void {
  behaviour = { kind: "error", error };
}

/** The arguments the agent actually sent, for asserting on the built prompt. */
export function lastConverseCall(): ConverseArgs | undefined {
  return lastArgs;
}

export function converseCallCount(): number {
  return converseText.mock.calls.length;
}

/** Which model the chain should report as having answered. */
export function setAnsweringModel(id: string): void {
  modelId = id;
}

export function resetBedrockStub(): void {
  behaviour = { kind: "reply", text: "" };
  modelId = DEFAULT_MODEL_ID;
  lastArgs = undefined;
  converseText.mockClear();
}
