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

// Which model actually answered, alongside its reply.
//
// `modelId` is not decoration: the Evaluator persists it on every EVAL# item
// because scores produced by two different models are not strictly comparable,
// and without the attribute that difference is invisible forever. See
// docs/architecture/data-model.md §1.
export type ConverseResult = {
  text: string;
  modelId: string;
};

// Walks `config.bedrockTextModelIds` in order and returns the first usable
// reply. Shared by every text agent so the fallback chain is defined once.
//
// `ConverseCommand` is what makes the chain cheap: one message format across
// Mistral, Meta and Qwen, so falling back is a config change rather than three
// request builders. An empty reply counts as a failure and moves to the next
// model — a 200 with no content is as useless to the caller as an exception.
//
// The chain's length is config, not code. The API service sets the full
// three-model list because a candidate is watching a progress bar and a slow
// answer beats none. The Evaluator worker sets a single id: it runs behind SQS,
// which already provides retries and a DLQ, so walking a chain there is a
// second, slower retry mechanism whose latency can outlive the queue's
// visibility timeout — and a redelivered message pays for a second generation.
export async function converseText(
  args: ConverseTextArgs
): Promise<ConverseResult> {
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
        return { text, modelId };
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

// A JSON Schema describing the object the model must produce.
//
// Structurally a JSON document, which is what the SDK's `DocumentType` wants —
// spelled out here rather than imported so the tool schema cannot quietly grow
// a value the wire format does not carry (a Date, a function, undefined).
//
// It is not a guarantee about the model's output. That comes from the caller's
// Zod parse; this only constrains what is asked for.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ToolInputSchema = { [key: string]: JsonValue };

export type ConverseStructuredArgs = {
  system: string;
  prompt: string;
  // The name is visible to the model and reads as an instruction, so it is
  // phrased as the action being taken rather than as a type name.
  toolName: string;
  toolDescription: string;
  inputSchema: ToolInputSchema;
  maxTokens?: number;
};

export type StructuredResult = {
  // Whatever the model produced, unvalidated. The caller parses it.
  value: unknown;
  modelId: string;
  // How the value was obtained. Worth surfacing because the fallback path is
  // materially less reliable, and a chain that silently never uses tool use is
  // something to find out about from a log rather than from a bad analysis.
  via: "toolUse" | "text";
};

// Asks for a structured object rather than prose, by giving the model exactly
// one tool and requiring it.
//
// `toolChoice: { tool }` is what makes this a constraint rather than a
// suggestion: the model cannot answer in prose, so there is no prompt to
// out-argue and no fenced JSON to recover from on the happy path.
//
// The text fallback is not redundant. Tool support varies across the three
// models in the chain and is not verified for all of them, so a model that
// ignores the tool and answers in prose still produces a usable object rather
// than a failed request — the fences it wraps that prose in are stripped by
// extractJsonObject at the call site.
export async function converseStructured(
  args: ConverseStructuredArgs
): Promise<StructuredResult> {
  const modelIds = config.bedrockTextModelIds;
  const failures: string[] = [];

  for (const modelId of modelIds) {
    try {
      const response = await bedrockClient.send(
        new ConverseCommand({
          modelId,
          system: [{ text: args.system }],
          messages: [{ role: "user", content: [{ text: args.prompt }] }],
          inferenceConfig: {
            maxTokens: args.maxTokens ?? BEDROCK.MAX_TOKENS,
            // Zero, not BEDROCK.TEMPERATURE. This is a classification into a
            // fixed set of buckets, and there is no version of it that benefits
            // from variety.
            temperature: 0,
          },
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: args.toolName,
                  description: args.toolDescription,
                  inputSchema: { json: args.inputSchema },
                },
              },
            ],
            toolChoice: { tool: { name: args.toolName } },
          },
        })
      );

      const content = response.output?.message?.content ?? [];

      // Walked rather than found with a type predicate: ContentBlock is a
      // closed union including an `$unknown` member, so a predicate narrowing
      // to a hand-written shape is rejected. Reading the field off each block
      // needs no narrowing at all.
      let toolInput: unknown;
      for (const block of content) {
        if ("toolUse" in block && block.toolUse?.input !== undefined) {
          toolInput = block.toolUse.input;
          break;
        }
      }

      if (toolInput !== undefined) {
        if (failures.length > 0) {
          console.warn(
            `[bedrock] structured answer from ${modelId} after ${failures.length} failed — ${failures.join(" | ")}`
          );
        }
        return { value: toolInput, modelId, via: "toolUse" };
      }

      // No tool block. The model answered in prose despite being required not
      // to, which some models in the chain do. Hand the text back for the
      // caller to strip and parse.
      const text = readText(content);
      if (text.length > 0) {
        console.warn(
          `[bedrock] ${modelId} ignored toolChoice and answered in text — falling back to parsing`
        );
        return { value: text, modelId, via: "text" };
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
