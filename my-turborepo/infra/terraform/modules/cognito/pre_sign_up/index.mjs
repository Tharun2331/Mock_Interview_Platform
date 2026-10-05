// Cognito pre sign-up trigger: refuses the addresses that make free-interview
// farming cheap.
//
// Every account gets three interviews without anyone granting anything, and each
// one is a billed Nova Sonic stream. Cognito's paid threat protection is out of
// scope for this project's budget, so this is the free substitute. It raises the
// cost of a throwaway account from "change one character" to "own another real
// mailbox":
//
//   - Disposable-mail domains (mailinator and friends). One of these gives an
//     attacker unlimited inboxes that pass email verification.
//   - Sub-addressing, like name+1@gmail.com. Every tag lands in the same inbox,
//     so one mailbox would otherwise be unlimited accounts. Controlled by
//     BLOCK_PLUS_ADDRESSING, because it also refuses a few people who use tags
//     on purpose.
//
// Only native sign-ups are checked. A Google sign-in (PreSignUp_ExternalProvider)
// carries an address Google has already verified and owns, and an admin-created
// user (PreSignUp_AdminCreateUser) is an operator's decision.
//
// It also verifies the sign-up form's Turnstile token — see the section below
// the address checks.
//
// Plain JavaScript with no dependencies, so Terraform can zip and ship this file
// as-is with no build step. (The SSM client it uses for the Turnstile secret
// ships with Lambda's Node runtime.) Runs well inside Lambda's free tier: one
// invocation per sign-up attempt.
//
// The thrown message reaches the browser inside "PreSignUp failed with error
// ...". The web app shows its own copy for that case (UserLambdaValidationException
// in apps/web/src/lib/errors.ts), so the wording here is for the logs.

/** Well-known disposable-mail providers. Extend per environment with the
 * BLOCKED_EMAIL_DOMAINS variable rather than editing this list. */
export const DISPOSABLE_DOMAINS = [
  "10minutemail.com",
  "1secmail.com",
  "1secmail.net",
  "1secmail.org",
  "burnermail.io",
  "discard.email",
  "dispostable.com",
  "emailondeck.com",
  "fakeinbox.com",
  "getnada.com",
  "grr.la",
  "guerrillamail.biz",
  "guerrillamail.com",
  "guerrillamail.de",
  "guerrillamail.info",
  "guerrillamail.net",
  "guerrillamail.org",
  "mailcatch.com",
  "maildrop.cc",
  "mailinator.com",
  "mailnesia.com",
  "mintemail.com",
  "moakt.com",
  "mohmal.com",
  "sharklasers.com",
  "spamgourmet.com",
  "temp-mail.io",
  "temp-mail.org",
  "tempail.com",
  "tempmail.com",
  "tempmail.dev",
  "tempmailo.com",
  "tempr.email",
  "throwawaymail.com",
  "tmpmail.net",
  "tmpmail.org",
  "trashmail.com",
  "trashmail.de",
  "yopmail.com",
  "yopmail.fr",
];

/**
 * @param {string} domain lowercased domain part of an email
 * @param {string[]} blocked
 * @returns {boolean} true for a blocked domain or any subdomain of one
 */
export function isBlockedDomain(domain, blocked) {
  return blocked.some(
    (entry) => domain === entry || domain.endsWith(`.${entry}`),
  );
}

/**
 * The decision, separated from the Lambda wiring so it can be tested directly.
 *
 * @param {string} email
 * @param {{ blockPlusAddressing: boolean, extraBlockedDomains: string[] }} options
 * @returns {string | null} a reason to refuse, or null to allow
 */
export function refusalReason(email, options) {
  const normalised = email.trim().toLowerCase();
  const at = normalised.lastIndexOf("@");
  if (at < 1 || at === normalised.length - 1) {
    return "A valid email address is required.";
  }

  const local = normalised.slice(0, at);
  const domain = normalised.slice(at + 1);

  if (
    isBlockedDomain(domain, [
      ...DISPOSABLE_DOMAINS,
      ...options.extraBlockedDomains,
    ])
  ) {
    return "Disposable email addresses cannot be used to sign up.";
  }

  if (options.blockPlusAddressing && local.includes("+")) {
    return "Email addresses with a + tag cannot be used to sign up.";
  }

  return null;
}

// ---------------------------------------------------------------------------
// Turnstile: proof that a person, not a script, filled in the sign-up form.
//
// The address checks above make a throwaway account cost a real mailbox. They
// do nothing about a script that has one: the web app signs up straight
// against Cognito, so anything that can call Cognito's SignUp API can create
// accounts without ever loading the page. The page's Turnstile widget produces
// a single-use token, sent as validationData (which Cognito hands to this
// trigger and never stores), and it is verified here with Cloudflare.
//
// A request with no token is exactly what a direct API call looks like, so it
// is refused like a failed one.
//
// TURNSTILE_MODE stages the rollout:
//   off      - not checked (the default, so an unconfigured function behaves
//              as before)
//   monitor  - checked and logged, never refused: proves real sign-ups carry
//              valid tokens before anything depends on it
//   enforce  - refused unless verified
//
// Fails closed. If Cloudflare cannot be reached the sign-up is refused, not
// waved through: this check exists to protect billed interview streams, and
// failing open would hand anyone able to slow the request a way around it.
// Cloudflare outages are rare and short, and the person simply retries.
// ---------------------------------------------------------------------------

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

// The widget renders with this action, and a token solved for any other
// action (another site's widget, another form) is refused.
export const TURNSTILE_ACTION = "signup";

// Cognito waits at most 5 seconds for the whole trigger. siteverify normally
// answers in well under half a second; this leaves room for the secret's
// first read and a slow answer without letting Cognito time out first.
const SITEVERIFY_TIMEOUT_MS = 2500;

/**
 * Checks one Turnstile token with Cloudflare.
 *
 * @param {string | undefined} token
 * @param {{ secret: string, allowedHostnames: string[], fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ ok: true, hostname: string } | { ok: false, reason: string }>}
 */
export async function verifyTurnstile(token, options) {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "no Turnstile token" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  let response;
  try {
    response = await fetchImpl(SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: options.secret, response: token }),
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      reason: `siteverify unreachable (${error instanceof Error ? error.name : "error"})`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: `siteverify answered ${response.status}` };
  }

  /** @type {{ success?: boolean, hostname?: string, action?: string, "error-codes"?: string[] }} */
  let result;
  try {
    result = await response.json();
  } catch {
    return { ok: false, reason: "siteverify answered something other than JSON" };
  }

  if (result.success !== true) {
    return {
      ok: false,
      reason: `token rejected (${(result["error-codes"] ?? []).join(",") || "no reason given"})`,
    };
  }
  if (result.action !== TURNSTILE_ACTION) {
    return { ok: false, reason: `token was for action "${result.action}"` };
  }
  if (!options.allowedHostnames.includes(result.hostname ?? "")) {
    return { ok: false, reason: `token was solved on ${result.hostname}` };
  }

  return { ok: true, hostname: result.hostname ?? "" };
}

/**
 * Reads the Turnstile secret from SSM. Per container, not per sign-up: a warm
 * function reuses it, and a failed read is retried on the next sign-up rather
 * than cached.
 *
 * The SDK is imported here, lazily, rather than at the top of the file: it
 * ships with Lambda's Node runtime but not with this repo's test environment,
 * and a static import would make the whole file untestable for one function.
 *
 * @param {string} name
 * @returns {Promise<string>}
 */
async function readSecretFromSsm(name) {
  const { SSMClient, GetParameterCommand } = await import(
    "@aws-sdk/client-ssm"
  );
  const output = await new SSMClient({}).send(
    new GetParameterCommand({ Name: name, WithDecryption: true }),
  );
  const value = output.Parameter?.Value;
  if (!value) throw new Error(`SSM parameter ${name} is empty`);
  return value;
}

/** Reads this function's configuration from its environment. */
function optionsFromEnv() {
  return {
    blockPlusAddressing: process.env.BLOCK_PLUS_ADDRESSING !== "false",
    extraBlockedDomains: (process.env.BLOCKED_EMAIL_DOMAINS ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
    turnstileMode: process.env.TURNSTILE_MODE ?? "off",
    turnstileSecretParameter: process.env.TURNSTILE_SECRET_PARAMETER ?? "",
    turnstileHostnames: (process.env.TURNSTILE_HOSTNAMES ?? "")
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  };
}

// The message a person sees, inside Cognito's "PreSignUp failed with error".
// Deliberately the same for every Turnstile failure: which check failed is for
// the logs, and telling a script is only telling it what to fix.
export const TURNSTILE_REFUSAL =
  "We could not confirm you are a person. Please try again.";

/**
 * The trigger, with its outside world injectable so it can be tested.
 *
 * @param {{ loadSecret?: (name: string) => Promise<string>, fetchImpl?: typeof fetch }} [deps]
 */
export function createHandler(deps = {}) {
  const loadSecret = deps.loadSecret ?? readSecretFromSsm;
  /** @type {Promise<string> | undefined} */
  let secret;

  /**
   * @param {{ triggerSource: string, request: { userAttributes?: Record<string, string>, validationData?: Record<string, string> } }} event
   */
  return async function handler(event) {
    if (event.triggerSource !== "PreSignUp_SignUp") return event;

    const options = optionsFromEnv();
    const email = event.request.userAttributes?.email ?? "";
    const reason = refusalReason(email, options);

    if (reason !== null) {
      // The domain only, never the full address: the log line needs to say what
      // was refused, not who tried.
      const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase();
      console.log(`[pre-sign-up] refused a sign-up at ${domain}: ${reason}`);
      throw new Error(reason);
    }

    if (options.turnstileMode !== "monitor" && options.turnstileMode !== "enforce") {
      return event;
    }

    let verdict;
    try {
      secret ??= loadSecret(options.turnstileSecretParameter);
      verdict = await verifyTurnstile(event.request.validationData?.turnstileToken, {
        secret: await secret,
        allowedHostnames: options.turnstileHostnames,
        fetchImpl: deps.fetchImpl,
      });
    } catch (error) {
      // Only the secret read can land here. Forget the failed promise so the
      // next sign-up tries again instead of failing forever.
      secret = undefined;
      verdict = {
        ok: false,
        reason: `secret unavailable (${error instanceof Error ? error.message : "error"})`,
      };
    }

    if (verdict.ok) {
      console.log(`[pre-sign-up] turnstile verified on ${verdict.hostname}`);
      return event;
    }

    if (options.turnstileMode === "monitor") {
      console.log(`[pre-sign-up] turnstile would refuse (monitor): ${verdict.reason}`);
      return event;
    }

    console.log(`[pre-sign-up] turnstile refused a sign-up: ${verdict.reason}`);
    throw new Error(TURNSTILE_REFUSAL);
  };
}

export const handler = createHandler();
