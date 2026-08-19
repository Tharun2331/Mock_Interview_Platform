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
});

type ConverseTextArgs = {
  system: string;
  prompt: string;
  maxTokens?: number;
  temperature?: number;
};

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
      const response = await bedrockClient.send(
        new ConverseCommand({
          modelId,
          system: [{ text: args.system }],
          messages: [{ role: "user", content: [{ text: args.prompt }] }],
          inferenceConfig: {
            maxTokens: args.maxTokens ?? BEDROCK.MAX_TOKENS,
            temperature: args.temperature ?? BEDROCK.TEMPERATURE,
          },
        })
      );

      const text = readText(response.output?.message?.content);
      if (text.length > 0) return text;

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
