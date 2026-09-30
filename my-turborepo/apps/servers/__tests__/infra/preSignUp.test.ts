import { afterEach, describe, expect, it } from "bun:test";
import {
  handler,
  isBlockedDomain,
  refusalReason,
} from "../../../../infra/terraform/modules/cognito/pre_sign_up/index.mjs";

// The Cognito pre sign-up trigger. It lives with its Terraform (no build step,
// zipped as-is) and is tested here because this is the suite CI runs.

const DEFAULTS = { blockPlusAddressing: true, extraBlockedDomains: [] };

function signUpEvent(email: string, triggerSource = "PreSignUp_SignUp") {
  return { triggerSource, request: { userAttributes: { email } } };
}

afterEach(() => {
  delete process.env.BLOCK_PLUS_ADDRESSING;
  delete process.env.BLOCKED_EMAIL_DOMAINS;
});

describe("refusalReason", () => {
  it("allows an ordinary address", () => {
    expect(refusalReason("tharun@example.com", DEFAULTS)).toBeNull();
    expect(refusalReason("first.last@gmail.com", DEFAULTS)).toBeNull();
  });

  it("refuses a disposable-mail domain, whatever the case", () => {
    expect(refusalReason("x@Mailinator.com", DEFAULTS)).toContain(
      "Disposable",
    );
  });

  it("refuses subdomains of a disposable domain", () => {
    expect(isBlockedDomain("inbox.mailinator.com", ["mailinator.com"])).toBe(
      true,
    );
    // But not a domain that merely ends in the same letters.
    expect(isBlockedDomain("notmailinator.com", ["mailinator.com"])).toBe(
      false,
    );
  });

  it("refuses + sub-addressing, the one-mailbox-many-accounts trick", () => {
    expect(refusalReason("tharun+3@gmail.com", DEFAULTS)).toContain("+ tag");
  });

  it("allows + sub-addressing when that check is switched off", () => {
    expect(
      refusalReason("tharun+3@gmail.com", {
        ...DEFAULTS,
        blockPlusAddressing: false,
      }),
    ).toBeNull();
  });

  it("refuses an environment's extra domains", () => {
    expect(
      refusalReason("x@burner.example", {
        ...DEFAULTS,
        extraBlockedDomains: ["burner.example"],
      }),
    ).toContain("Disposable");
  });

  it("refuses something that is not an address", () => {
    expect(refusalReason("no-at-sign", DEFAULTS)).not.toBeNull();
    expect(refusalReason("@example.com", DEFAULTS)).not.toBeNull();
    expect(refusalReason("name@", DEFAULTS)).not.toBeNull();
  });
});

describe("handler", () => {
  it("passes an allowed native sign-up through unchanged", async () => {
    const event = signUpEvent("tharun@example.com");
    expect(await handler(event)).toBe(event);
  });

  it("throws for a refused native sign-up, which makes Cognito refuse it", async () => {
    expect(handler(signUpEvent("x@yopmail.com"))).rejects.toThrow(
      "Disposable",
    );
  });

  it("never checks a Google sign-in: Google already verified that address", async () => {
    const event = signUpEvent("x+tag@gmail.com", "PreSignUp_ExternalProvider");
    expect(await handler(event)).toBe(event);
  });

  it("reads its switches from the environment", async () => {
    process.env.BLOCK_PLUS_ADDRESSING = "false";
    process.env.BLOCKED_EMAIL_DOMAINS = "Burner.Example, other.example";

    expect(await handler(signUpEvent("a+b@example.com"))).toBeDefined();
    expect(handler(signUpEvent("a@burner.example"))).rejects.toThrow();
  });
});
