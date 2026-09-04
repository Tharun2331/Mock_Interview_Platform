import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "../lib/config";

// Times each model in the text fallback chain individually.
//
// `converseText` walks the chain and returns the first usable reply, which
// means a model that hangs is invisible: the caller sees a slow success, not a
// failure, and the reason never reaches a log. This calls each id on its own so
// a stalled model can be told apart from a slow one.
//
// One short prompt per model, so the Bedrock cost is a rounding error.
//
// Run from apps/servers: `bun scripts/modelProbe.ts`

// No retries, so the number printed is one real attempt rather than an attempt
// budget — the whole point is to see the per-model latency, not the SDK's.
const client = new BedrockRuntimeClient({
  region: config.awsRegion,
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
});

for (const modelId of config.bedrockTextModelIds) {
  const startedAt = Date.now();

  try {
    const response = await client.send(
      new ConverseCommand({
        modelId,
        messages: [{ role: "user", content: [{ text: "Reply with the single word: ok" }] }],
        inferenceConfig: { maxTokens: 16, temperature: 0 },
      })
    );

    const text = response.output?.message?.content
      ?.map((block) => ("text" in block ? block.text : ""))
      .join("")
      .trim();

    console.log(`ok    ${Date.now() - startedAt}ms  ${modelId}  -> ${text}`);
  } catch (error) {
    console.log(
      `FAIL  ${Date.now() - startedAt}ms  ${modelId}  -> ${
        error instanceof Error ? `${error.name}: ${error.message}` : "unknown"
      }`
    );
  }
}
