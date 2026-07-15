import { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";
import { config } from "./config";

export const bedrockClient = new BedrockRuntimeClient({
  region: config.awsRegion,
});

