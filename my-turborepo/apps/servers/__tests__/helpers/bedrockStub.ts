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

type Behaviour =
  { kind: "reply"; text: string } | { kind: "error"; error: Error };

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
  },
);

// The structured (tool-use) half of the same module.
//
// It lives here rather than in a second stub because `mock.module` replaces the
// WHOLE module: a file registering `{ converseStructured }` on its own would
// delete `converseText` for every test loaded afterwards, and vice versa. That
// is not hypothetical — it broke two files the first time the Gap agent's tests
// registered their own mock, with "Export named 'converseStructured' not found".
//
// Every export of lib/bedrock that any test needs belongs in this one object.
export type ConverseStructuredResult = {
  value: unknown;
  modelId: string;
  via: "toolUse" | "text";
};

type StructuredBehaviour =
  | { kind: "value"; result: ConverseStructuredResult }
  | { kind: "error"; error: Error };

// A queue rather than a single value, because the agents that use this retry:
// a test for "fails once, succeeds on the retry" needs two different answers to
// the same call.
let structuredQueue: StructuredBehaviour[] = [];
let lastStructuredArgs: unknown;

// Per-tool replies, checked before the queue. A worker test drives two agents
// through this one function — the Evaluator on every answer, then the Session
// Summarizer once — and a single shared queue would have to predict how their
// calls interleave. Keyed by tool name, each agent gets its own answer.
export type StructuredArgs = {
  system: string;
  prompt: string;
  toolName: string;
  temperature?: number;
};

// A sequence per tool; the last entry repeats once the rest are used, the same
// rule as the queue below. One entry means "every call answers this".
const toolBehaviours = new Map<string, StructuredBehaviour[]>();
const toolCalls = new Map<string, StructuredArgs[]>();

export const converseStructured = mock(
  async (args: unknown): Promise<ConverseStructuredResult> => {
    lastStructuredArgs = args;

    const toolName = (args as Partial<StructuredArgs>).toolName;
    if (toolName !== undefined) {
      toolCalls.set(toolName, [
        ...(toolCalls.get(toolName) ?? []),
        args as StructuredArgs,
      ]);
      const sequence = toolBehaviours.get(toolName);
      const forTool =
        sequence !== undefined && sequence.length > 1
          ? sequence.shift()
          : sequence?.[0];
      if (forTool !== undefined) {
        if (forTool.kind === "error") throw forTool.error;
        // Read at call time, so setAnsweringModel applies whenever it is set.
        return { ...forTool.result, modelId };
      }
    }

    // The last entry repeats once the queue is exhausted, so a test that wants
    // the same answer every time configures one.
    const next =
      structuredQueue.length > 1 ? structuredQueue.shift() : structuredQueue[0];

    if (next === undefined) {
      throw new Error("converseStructured called with no behaviour configured");
    }
    if (next.kind === "error") throw next.error;
    return next.result;
  },
);

// Relative to THIS file, so it resolves to apps/servers/lib/bedrock.
mock.module("../../lib/bedrock", () => ({ converseText, converseStructured }));

const DEFAULT_STRUCTURED_MODEL = "mistral.ministral-3-8b-instruct";

/** The object a tool-use reply should carry. */
export function setStructuredReplies(values: unknown[]): void {
  structuredQueue = values.map((value) => ({
    kind: "value",
    result: { value, modelId: DEFAULT_STRUCTURED_MODEL, via: "toolUse" },
  }));
}

/** A model that ignored toolChoice and answered in prose instead. */
export function setStructuredTextReplies(texts: string[]): void {
  structuredQueue = texts.map((value) => ({
    kind: "value",
    result: { value, modelId: DEFAULT_STRUCTURED_MODEL, via: "text" },
  }));
}

export function setStructuredFailure(error: Error): void {
  structuredQueue = [{ kind: "error", error }];
}

export function lastStructuredCall(): unknown {
  return lastStructuredArgs;
}

export function structuredCallCount(): number {
  return converseStructured.mock.calls.length;
}

export function resetStructuredStub(): void {
  structuredQueue = [];
  lastStructuredArgs = undefined;
  toolBehaviours.clear();
  toolCalls.clear();
  converseStructured.mockClear();
}

/**
 * What one tool's calls return, every time. An object is a tool-use reply; a
 * string is a model that ignored toolChoice and answered in prose.
 */
export function setToolReply(toolName: string, value: unknown): void {
  setToolReplies(toolName, [value]);
}

/** One reply per call, in order; the last repeats. For retry tests. */
export function setToolReplies(toolName: string, values: unknown[]): void {
  toolBehaviours.set(
    toolName,
    values.map((value) => ({
      kind: "value",
      result: {
        value,
        modelId: DEFAULT_STRUCTURED_MODEL,
        via: typeof value === "string" ? "text" : "toolUse",
      },
    })),
  );
}

/** Make one tool's calls fail — the Bedrock chain exhausted, or a hang. */
export function setToolFailure(toolName: string, error: Error): void {
  toolBehaviours.set(toolName, [{ kind: "error", error }]);
}

/** The arguments of the most recent call for one tool. */
export function lastToolCall(toolName: string): StructuredArgs | undefined {
  return toolCalls.get(toolName)?.at(-1);
}

export function toolCallCount(toolName: string): number {
  return toolCalls.get(toolName)?.length ?? 0;
}

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
