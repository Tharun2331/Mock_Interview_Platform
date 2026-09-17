import { describe, expect, it } from "bun:test";
import { keySource } from "../../lib/tavily";

// Where the Tavily key comes from, and the rule that keeps a laptop's
// convenience out of production.
//
// Two gates, and only the second one is here. config.ts blanks the direct key
// whenever NODE_ENV is production, so by the time this function runs on a
// deployed task the direct key is already an empty string and "ssm" is the
// only reachable answer. This pins the precedence; the production gate is a
// property of config.ts and is asserted by the emptiness it produces.

describe("keySource", () => {
  it("prefers a direct key when one is set", () => {
    expect(keySource("tvly-dev-abc", "/prepilot/dev/tavily/apikey")).toBe("direct");
  });

  it("falls back to SSM when no direct key is set", () => {
    expect(keySource("", "/prepilot/dev/tavily/apikey")).toBe("ssm");
  });

  // What production looks like after config.ts has blanked the direct key.
  // There is no third branch: SSM is the answer, and getSecret raises a clear
  // ServiceError if the parameter name is missing too.
  it("chooses SSM in the shape production always has", () => {
    expect(keySource("", "/prepilot/prod/tavily/apikey")).toBe("ssm");
  });

  // A whitespace-only value is somebody clearing the variable by deleting the
  // key and leaving a space, not somebody configuring a direct key. It must
  // not shadow SSM — that would send " " to Tavily as a bearer token and fail
  // as a 401 nobody can explain.
  it("treats a blank direct key as no direct key", () => {
    expect(keySource("   ", "/prepilot/dev/tavily/apikey")).toBe("ssm");
  });
});
