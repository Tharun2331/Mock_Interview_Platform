import { describe, expect, it } from "bun:test";
import {
  extractGithubUsername,
  formatMegabytes,
  GITHUB_USERNAME_REGEX,
  PreInterviewRepo,
  RESUME_LIMITS,
} from "../../src/schemas/preInterview";

// extractGithubUsername is the boundary between a user-supplied string and an
// outbound request path, so its rejections matter more than its acceptances.
// The cases below are the ones the implementation comment names as the reason
// it parses with `URL` instead of splitting on "/".
describe("extractGithubUsername", () => {
  it("returns the owner of a canonical profile URL", () => {
    expect(extractGithubUsername("https://github.com/Tharun2331")).toBe(
      "Tharun2331"
    );
  });

  it("accepts the www host and surrounding whitespace", () => {
    expect(extractGithubUsername("  https://www.github.com/octocat  ")).toBe(
      "octocat"
    );
  });

  it("accepts http as well as https", () => {
    expect(extractGithubUsername("http://github.com/octocat")).toBe("octocat");
  });

  it("is case-insensitive about the host but not the username", () => {
    expect(extractGithubUsername("https://GitHub.com/OctoCat")).toBe("OctoCat");
  });

  // The two attack shapes the comment calls out by name. A `.split("/").pop()`
  // implementation returns "Tharun2331" for both.
  it("rejects a lookalike host that merely ends in the username", () => {
    expect(extractGithubUsername("https://evil.com/Tharun2331")).toBeNull();
  });

  it("rejects userinfo smuggling the real host into the authority", () => {
    expect(extractGithubUsername("https://github.com@evil.com")).toBeNull();
  });

  it("rejects a subdomain of an attacker's domain", () => {
    expect(extractGithubUsername("https://github.com.evil.com/octocat")).toBeNull();
  });

  it("rejects a repository URL — a profile has exactly one path segment", () => {
    expect(extractGithubUsername("https://github.com/octocat/hello-world")).toBeNull();
  });

  it("rejects the bare host with no username", () => {
    expect(extractGithubUsername("https://github.com")).toBeNull();
    expect(extractGithubUsername("https://github.com/")).toBeNull();
  });

  it("rejects non-http protocols", () => {
    expect(extractGithubUsername("javascript:alert(1)")).toBeNull();
    expect(extractGithubUsername("ftp://github.com/octocat")).toBeNull();
    expect(extractGithubUsername("file:///github.com/octocat")).toBeNull();
  });

  it("rejects a bare username that is not a URL at all", () => {
    expect(extractGithubUsername("octocat")).toBeNull();
    expect(extractGithubUsername("")).toBeNull();
  });

  // Percent-encoded traversal is why the allowlist regex is applied after
  // parsing rather than trusted to the URL parser alone.
  it("rejects percent-encoded path traversal in the username slot", () => {
    expect(extractGithubUsername("https://github.com/%2e%2e")).toBeNull();
    expect(extractGithubUsername("https://github.com/..")).toBeNull();
  });
});

// GitHub's own rule, used as a strict allowlist. The hyphen cases are the ones
// worth pinning: the regex permits interior single hyphens only.
describe("GITHUB_USERNAME_REGEX", () => {
  it("accepts names with interior single hyphens", () => {
    expect(GITHUB_USERNAME_REGEX.test("a-b")).toBe(true);
    expect(GITHUB_USERNAME_REGEX.test("octo-cat-9")).toBe(true);
  });

  it("accepts a single character", () => {
    expect(GITHUB_USERNAME_REGEX.test("a")).toBe(true);
  });

  it("rejects leading and trailing hyphens", () => {
    expect(GITHUB_USERNAME_REGEX.test("-octocat")).toBe(false);
    expect(GITHUB_USERNAME_REGEX.test("octocat-")).toBe(false);
  });

  it("rejects consecutive hyphens", () => {
    expect(GITHUB_USERNAME_REGEX.test("octo--cat")).toBe(false);
  });

  it("enforces the 39-character ceiling", () => {
    expect(GITHUB_USERNAME_REGEX.test("a".repeat(39))).toBe(true);
    expect(GITHUB_USERNAME_REGEX.test("a".repeat(40))).toBe(false);
  });

  it("rejects path and encoding characters", () => {
    expect(GITHUB_USERNAME_REGEX.test("a/b")).toBe(false);
    expect(GITHUB_USERNAME_REGEX.test("%2e%2e")).toBe(false);
    expect(GITHUB_USERNAME_REGEX.test("octo_cat")).toBe(false);
    expect(GITHUB_USERNAME_REGEX.test("octo.cat")).toBe(false);
  });
});

// This string ends up inside the size-limit error message the candidate reads,
// so the rounding is user-facing rather than cosmetic.
describe("formatMegabytes", () => {
  it("renders the upload ceiling the way the error message quotes it", () => {
    expect(formatMegabytes(RESUME_LIMITS.MAX_BYTES)).toBe("8.0 MB");
  });

  it("keeps one decimal place", () => {
    expect(formatMegabytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatMegabytes(1.55 * 1024 * 1024)).toBe("1.6 MB");
    expect(formatMegabytes(0)).toBe("0.0 MB");
  });
});

describe("PreInterviewRepo", () => {
  it("accepts a null description — GitHub returns null for undescribed repos", () => {
    const parsed = PreInterviewRepo.safeParse({
      description: null,
      name: "order-service",
      fullName: "octocat/order-service",
      starCount: 42,
    });

    expect(parsed.success).toBe(true);
  });

  it("rejects the snake_case shape GitHub actually returns", () => {
    // The projection to camelCase happens in lib/github.ts. If that mapping is
    // ever dropped, this schema is what catches it.
    const parsed = PreInterviewRepo.safeParse({
      description: null,
      name: "order-service",
      full_name: "octocat/order-service",
      stargazers_count: 42,
    });

    expect(parsed.success).toBe(false);
  });
});
