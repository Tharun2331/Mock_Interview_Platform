import { describe, expect, it } from "bun:test";
import { resolveCorsOrigins } from "../../lib/config";

// The CORS allowlist is the list of pages trusted to call the API with a
// candidate's token, so production gets stricter rules than a laptop.
describe("resolveCorsOrigins", () => {
  it("defaults to the local web app outside production", () => {
    expect(resolveCorsOrigins(undefined, false)).toEqual([
      "http://localhost:3000",
    ]);
    expect(resolveCorsOrigins("", false)).toEqual(["http://localhost:3000"]);
  });

  it("refuses to boot in production with no origins set", () => {
    // The old default silently allowed http://localhost:3000 in a deployed
    // service. An unset variable must be a failed boot, not a policy.
    expect(() => resolveCorsOrigins(undefined, true)).toThrow("must be set");
    expect(() => resolveCorsOrigins("  ", true)).toThrow("must be set");
  });

  it("accepts https origins in production", () => {
    expect(
      resolveCorsOrigins(
        "https://preppilot.tharunsekar.xyz, https://tharunsekar.xyz",
        true,
      ),
    ).toEqual(["https://preppilot.tharunsekar.xyz", "https://tharunsekar.xyz"]);
  });

  it("refuses a plaintext origin in production", () => {
    expect(() =>
      resolveCorsOrigins(
        "https://preppilot.tharunsekar.xyz,http://localhost:3000",
        true,
      ),
    ).toThrow("non-https");
  });

  it("refuses a wildcard in production", () => {
    expect(() => resolveCorsOrigins("https://*.tharunsekar.xyz", true)).toThrow(
      "wildcard",
    );
  });

  it("keeps plaintext localhost usable in development", () => {
    expect(resolveCorsOrigins("http://localhost:3000", false)).toEqual([
      "http://localhost:3000",
    ]);
  });
});
