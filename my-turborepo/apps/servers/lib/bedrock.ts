import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config";
import { BEDROCK } from "./constants";
import { BedrockError } from "./errors";

export const bedrockClient = new BedrockRuntimeClient({
  region: config.awsRegion,
  // Same reasoning as `githubTimeoutMs` on the GitHub call: without these a
  // stalled upstream holds the candidate's request open indefinitely, and the
  // fallback chain below never gets to run because the first model never
  // fails. A timeout is what turns a hang into a fallback.
  maxAttempts: BEDROCK.MAX_ATTEMPTS,
  requestHandler: {
    connectionTimeout: BEDROCK.CONNECTION_TIMEOUT_MS,
    requestTimeout: BEDROCK.REQUEST_TIMEOUT_MS,
  },
});

// One demonstrated input/output pair, shaped exactly like a real call.
export type ExampleTurn = { user: string; assistant: string };

type ConverseTextArgs = {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
  // Sent as real conversation turns rather than text pasted into the system
  // prompt. An 8B model follows a demonstrated mapping far more reliably than
  // a described one, and the position matters — as message history it reads as
  // "this is what you did last time", not "here is some documentation".
  exampleTurns?: ExampleTurn[];
};

// Deliberately absent: assistant prefill (seeding the reply with "{" so the
// model continues into JSON rather than opening with prose). It is a standard
// trick on Claude, but `mistral.ministral-3-8b-instruct` — the primary model —
// rejects the request outright with
// `Cannot set add_generation_prompt to True when the last message is from the
// assistant`, verified against Bedrock 2026-08-26. Qwen accepts the message and
// then ignores it. So the technique costs a hard 400 on the model that serves
// almost every request and buys nothing on the one that doesn't. Prose-wrapped
// JSON is handled after the fact by each agent's extractor instead.

// Converse returns content as an array of blocks. A text reply is normally a
// single block, but the shape permits several, so join rather than take [0].
function readText(blocks: ContentBlock[] | undefined): string {
  if (blocks === undefined) return "";

  return blocks
    .map((block) =>
      "text" in block && typeof block.text === "string" ? block.text : ""
    )
    .join("")
    .trim();
}

// Walks `config.bedrockTextModelIds` in order and returns the first usable
// reply. Shared by every text agent so the fallback chain is defined once.
//
// `ConverseCommand` is what makes the chain cheap: one message format across
// Mistral, Meta and Qwen, so falling back is a config change rather than three
// request builders. An empty reply counts as a failure and moves to the next
// model — a 200 with no content is as useless to the caller as an exception.
export async function converseText(args: ConverseTextArgs): Promise<string> {
  const modelIds = config.bedrockTextModelIds;
  const failures: string[] = [];

  for (const modelId of modelIds) {
    try {
      const exampleMessages = (args.exampleTurns ?? []).flatMap((turn) => [
        { role: "user" as const, content: [{ text: turn.user }] },
        { role: "assistant" as const, content: [{ text: turn.assistant }] },
      ]);

      const response = await bedrockClient.send(
        new ConverseCommand({
          modelId,
          system: [{ text: args.system }],
          messages: [
            ...exampleMessages,
            { role: "user" as const, content: [{ text: args.prompt }] },
          ],
          inferenceConfig: {
            maxTokens: args.maxTokens ?? BEDROCK.MAX_TOKENS,
            temperature: args.temperature ?? BEDROCK.TEMPERATURE,
          },
        })
      );

      const text = readText(response.output?.message?.content);
      if (text.length > 0) {
        // A fallback that works is still a fault, and it used to leave no
        // trace: the caller saw a slow success and the reason the primary was
        // skipped never reached a log. That is how a dead primary model hid
        // behind a working chain while adding a minute and a half to every
        // request. Only logged when something was actually skipped, so the
        // healthy path stays quiet.
        if (failures.length > 0) {
          console.warn(
            `[bedrock] answered by ${modelId} after ${failures.length} failed — ${failures.join(" | ")}`
          );
        }
        return text;
      }

      failures.push(`${modelId}: empty response`);
    } catch (error) {
      failures.push(
        `${modelId}: ${error instanceof Error ? error.message : "unknown error"}`
      );
    }
  }

  throw new BedrockError(
    `All Bedrock text models failed — ${failures.join(" | ")}`,
    modelIds
  );
}
