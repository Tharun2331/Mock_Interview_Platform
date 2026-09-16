import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { config } from "./config";
import { ServiceError } from "./errors";
import { MESSAGES } from "./messages";

// Secrets read from Parameter Store at the point of use.
//
// One shared client per service, as every other AWS module here does — never
// `new SSMClient()` inside a handler.

const ssmClient = new SSMClient({ region: config.awsRegion });

// Read once per process, not once per request. A parameter fetch is a network
// call on the critical path of an interview being planned, and the value it
// returns changes about never — rotating the key is a deploy, and a deploy
// replaces the task.
//
// Cached by name so a second parameter added later does not inherit the first
// one's value, which a single `let cached` would have done silently.
const cache = new Map<string, string>();

/**
 * Reads a SecureString parameter, decrypted.
 *
 * Throws rather than returning undefined: every caller needs the value to do
 * its job, and a missing secret is a misconfigured deployment rather than a
 * degraded one. Callers that can degrade — Company Intel is the only one so
 * far — catch it themselves and say what they lost.
 */
export async function getSecret(name: string): Promise<string> {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;

  if (name.length === 0) {
    throw new ServiceError(`${MESSAGES.SSM_PARAMETER_MISSING} — no name given`);
  }

  let response;
  try {
    response = await ssmClient.send(
      new GetParameterCommand({ Name: name, WithDecryption: true })
    );
  } catch (error) {
    // The parameter name is ours and safe to log; the value never is, and a
    // failed GetParameter does not carry one.
    throw new ServiceError(
      `${MESSAGES.SSM_PARAMETER_MISSING} — ${name}: ${
        error instanceof Error ? error.message : "unknown"
      }`
    );
  }

  const value = response.Parameter?.Value;
  if (value === undefined || value.length === 0) {
    // A parameter that exists with an empty value is the shape Terraform leaves
    // behind when it creates the resource and a human never fills it in. Worth
    // its own message: "not found" would send someone looking in the wrong place.
    throw new ServiceError(`${MESSAGES.SSM_PARAMETER_EMPTY} — ${name}`);
  }

  cache.set(name, value);
  return value;
}

/** Test seam. Nothing in production clears this — the cache lives as long as
 *  the process, which is the point of it. */
export function resetSecretCache(): void {
  cache.clear();
}
