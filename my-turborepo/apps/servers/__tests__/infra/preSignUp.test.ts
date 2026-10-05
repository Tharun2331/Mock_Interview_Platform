import { afterEach, describe, expect, it } from "bun:test";
import {
  createHandler,
  handler,
  isBlockedDomain,
  refusalReason,
  SITEVERIFY_URL,
  TURNSTILE_ACTION,
  TURNSTILE_REFUSAL,
  verifyTurnstile,
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
  delete process.env.TURNSTILE_MODE;
  delete process.env.TURNSTILE_SECRET_PARAMETER;
  delete process.env.TURNSTILE_HOSTNAMES;
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

// ---------------------------------------------------------------------------
// Turnstile. Cloudflare and SSM are both injected: `fetchImpl` stands in for
// siteverify and `loadSecret` for the SSM read, so nothing leaves the process.
// ---------------------------------------------------------------------------

const HOSTS = ["preppilot-dev.tharunsekar.xyz", "localhost"];

/** A siteverify answer, shaped as Cloudflare sends it. */
function siteverify(body: Record<string, unknown>, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

const VERIFIED = {
  success: true,
  hostname: "preppilot-dev.tharunsekar.xyz",
  action: TURNSTILE_ACTION,
};

// The shape Cognito hands the trigger. Annotated rather than inferred: the
// inferred union `{} | { turnstileToken: string }` is not a Record<string,
// string>, which is what the handler declares.
type PreSignUpEvent = {
  triggerSource: string;
  request: {
    userAttributes: Record<string, string>;
    validationData: Record<string, string>;
  };
};

function withToken(token?: string, email = "tharun@example.com"): PreSignUpEvent {
  const validationData: Record<string, string> = {};
  if (token !== undefined) validationData.turnstileToken = token;

  return {
    triggerSource: "PreSignUp_SignUp",
    request: { userAttributes: { email }, validationData },
  };
}

function turnstileOn(mode: "monitor" | "enforce") {
  process.env.TURNSTILE_MODE = mode;
  process.env.TURNSTILE_SECRET_PARAMETER = "/prepilot/test/turnstile/secret_key";
  process.env.TURNSTILE_HOSTNAMES = HOSTS.join(",");
}

const secret = async () => "s";

describe("verifyTurnstile", () => {
  it("accepts a token Cloudflare verified for this action on an allowed host", async () => {
    const result = await verifyTurnstile("tok", {
      secret: "s",
      allowedHostnames: HOSTS,
      fetchImpl: siteverify(VERIFIED),
    });
    expect(result.ok).toBe(true);
  });

  // A direct call to Cognito's SignUp API — the hole this closes — sends none.
  it("refuses a missing token without asking Cloudflare", async () => {
    let called = false;
    const result = await verifyTurnstile(undefined, {
      secret: "s",
      allowedHostnames: HOSTS,
      fetchImpl: (async () => {
        called = true;
        return new Response("{}");
      }) as unknown as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it.each([
    [
      "Cloudflare rejected the token",
      { success: false, "error-codes": ["timeout-or-duplicate"] },
    ],
    ["it was solved for another form", { ...VERIFIED, action: "login" }],
    ["it was solved on another site", { ...VERIFIED, hostname: "evil.example" }],
  ])("refuses when %s", async (_label, body) => {
    const result = await verifyTurnstile("tok", {
      secret: "s",
      allowedHostnames: HOSTS,
      fetchImpl: siteverify(body),
    });
    expect(result.ok).toBe(false);
  });

  // Fail closed: an outage must not become a way around the check.
  it("refuses when Cloudflare cannot be reached", async () => {
    const result = await verifyTurnstile("tok", {
      secret: "s",
      allowedHostnames: HOSTS,
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      ok: false,
      reason: "siteverify unreachable (TypeError)",
    });
  });

  it("refuses when Cloudflare answers with an error or not JSON", async () => {
    const notJson = (async () =>
      new Response("<html>", { status: 200 })) as unknown as typeof fetch;

    for (const fetchImpl of [siteverify({}, 500), notJson]) {
      const result = await verifyTurnstile("tok", {
        secret: "s",
        allowedHostnames: HOSTS,
        fetchImpl,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("sends the secret and the token to siteverify", async () => {
    let sent: { url?: string; body?: string } = {};
    await verifyTurnstile("the-token", {
      secret: "the-secret",
      allowedHostnames: HOSTS,
      fetchImpl: (async (url: string, init: RequestInit) => {
        sent = { url, body: String(init.body) };
        return new Response(JSON.stringify(VERIFIED));
      }) as unknown as typeof fetch,
    });
    expect(sent.url).toBe(SITEVERIFY_URL);
    expect(sent.body).toBe("secret=the-secret&response=the-token");
  });
});

describe("handler with Turnstile", () => {
  it("is off unless switched on, so an unconfigured function behaves as before", async () => {
    const event = withToken(undefined);
    expect(await handler(event)).toBe(event);
  });

  it("enforce: lets a verified sign-up through", async () => {
    turnstileOn("enforce");
    const run = createHandler({ loadSecret: secret, fetchImpl: siteverify(VERIFIED) });
    const event = withToken("tok");
    expect(await run(event)).toBe(event);
  });

  it("enforce: refuses a sign-up with no token, with one message for every cause", async () => {
    turnstileOn("enforce");
    const run = createHandler({ loadSecret: secret, fetchImpl: siteverify(VERIFIED) });
    expect(run(withToken(undefined))).rejects.toThrow(TURNSTILE_REFUSAL);
  });

  // Monitor exists to prove tokens arrive before anything depends on them.
  it("monitor: never refuses, even with no token", async () => {
    turnstileOn("monitor");
    const run = createHandler({
      loadSecret: secret,
      fetchImpl: siteverify({ success: false }),
    });
    const event = withToken(undefined);
    expect(await run(event)).toBe(event);
  });

  // Cheap checks first: a disposable domain is refused without a network call.
  it("refuses a disposable address before asking Cloudflare", async () => {
    turnstileOn("enforce");
    let called = false;
    const run = createHandler({
      loadSecret: secret,
      fetchImpl: (async () => {
        called = true;
        return new Response(JSON.stringify(VERIFIED));
      }) as unknown as typeof fetch,
    });
    expect(run(withToken("tok", "x@yopmail.com"))).rejects.toThrow("Disposable");
    expect(called).toBe(false);
  });

  it("still never checks a Google sign-in, which cannot carry a token", async () => {
    turnstileOn("enforce");
    const run = createHandler({
      loadSecret: secret,
      fetchImpl: siteverify({ success: false }),
    });
    const event = { ...withToken(undefined), triggerSource: "PreSignUp_ExternalProvider" };
    expect(await run(event)).toBe(event);
  });

  it("reads the secret once per container, and retries a failed read", async () => {
    turnstileOn("enforce");
    let reads = 0;
    const run = createHandler({
      loadSecret: async () => {
        reads += 1;
        if (reads === 1) throw new Error("ssm throttled");
        return "s";
      },
      fetchImpl: siteverify(VERIFIED),
    });

    // The first read fails: refused (fail closed), and the failure not cached.
    await expect(run(withToken("tok"))).rejects.toThrow(TURNSTILE_REFUSAL);
    // The second read succeeds and is cached; the third sign-up reuses it.
    await run(withToken("tok"));
    await run(withToken("tok"));
    expect(reads).toBe(2);
  });
});
